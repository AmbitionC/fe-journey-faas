"""版本里的“配置”和“外壳代码”两层怎么作用到被测 Agent 上。

配置是一组有边界的旋钮；外壳代码是一个只含 transform_result 函数的小模块，
加载前先做静态检查：进化链路产出的代码不能随便 import、不能碰文件和网络。
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from typing import Any, Callable

ALL_TOOLS = ["read_file", "write_file", "edit_file", "find_files", "search_text", "run_command"]

DEFAULT_CONFIG: dict[str, Any] = {
    "loop.max_turns": 30,
    "tools.enabled": list(ALL_TOOLS),
    "tools.result_limit": 8000,      # 单个工具结果交给模型的长度上限，超出保留头尾
    "reminders.after_edit": "",      # 修改文件后追加给模型的一句提示
}


@dataclass
class Int:
    lo: int
    hi: int

    def check(self, v: Any) -> str | None:
        return None if isinstance(v, int) and not isinstance(v, bool) and self.lo <= v <= self.hi \
            else f"应为 {self.lo}~{self.hi} 的整数"


@dataclass
class Text:
    max_len: int

    def check(self, v: Any) -> str | None:
        return None if isinstance(v, str) and len(v) <= self.max_len else f"应为不超过 {self.max_len} 字的文本"


@dataclass
class Subset:
    universe: list[str]
    required: set[str]

    def check(self, v: Any) -> str | None:
        if not isinstance(v, list) or any(x not in self.universe for x in v):
            return f"只能从 {self.universe} 里选"
        return None if self.required <= set(v) else f"必须包含 {sorted(self.required)}"


# 提案器能动的范围。范围之外的修改直接拒绝，连评测都不跑。
BOUNDS: dict[str, Int | Text | Subset] = {
    "loop.max_turns": Int(6, 60),
    "tools.enabled": Subset(ALL_TOOLS, {"read_file", "run_command"}),
    "tools.result_limit": Int(500, 20000),
    "reminders.after_edit": Text(300),
}


def validate_config(changes: dict[str, Any]) -> list[str]:
    errors = []
    for key, value in changes.items():
        bound = BOUNDS.get(key)
        if bound is None:
            errors.append(f"{key}：不是可调的配置项")
        elif (msg := bound.check(value)):
            errors.append(f"{key}：{msg}")
    return errors


def effective_config(config: dict[str, Any]) -> dict[str, Any]:
    return {**DEFAULT_CONFIG, **config}


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    head, tail = limit // 3, limit - limit // 3
    return f"{text[:head]}\n……（中间省略 {len(text) - limit} 字）……\n{text[-tail:]}"


# ── 外壳代码 ──
ALLOWED_IMPORTS = {"re", "json", "textwrap"}
BANNED_NAMES = {"open", "exec", "eval", "compile", "__import__", "globals", "locals", "getattr", "setattr",
                "delattr", "input", "breakpoint", "vars"}

DEFAULT_CODE = '''def transform_result(name, args, result):
    """工具结果交给模型之前的最后一道加工。默认原样返回。"""
    return result
'''


def check_code(source: str) -> list[str]:
    """静态检查。通过了才允许加载。"""
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [f"语法错误：{e.msg}（第 {e.lineno} 行）"]
    errors = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            errors += [f"不允许 import {a.name}" for a in node.names if a.name.split(".")[0] not in ALLOWED_IMPORTS]
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[0] not in ALLOWED_IMPORTS:
                errors.append(f"不允许 from {node.module} import")
        elif isinstance(node, ast.Name) and node.id in BANNED_NAMES:
            errors.append(f"不允许使用 {node.id}")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            errors.append(f"不允许访问 {node.attr}")
    if not any(isinstance(n, ast.FunctionDef) and n.name == "transform_result" for n in tree.body):
        errors.append("必须定义 transform_result(name, args, result)")
    return errors


def load_hook(source: str) -> Callable[[str, dict, str], str]:
    errors = check_code(source)
    if errors:
        raise ValueError("；".join(errors))
    scope: dict[str, Any] = {}
    exec(compile(source, "<harness>", "exec"), scope)  # noqa: S102 —— 已通过上面的静态检查
    fn = scope["transform_result"]

    def safe(name: str, args: dict, result: str) -> str:
        try:
            out = fn(name, args, result)
        except Exception:
            return result       # 钩子出错不能让一次运行跟着失败
        return out if isinstance(out, str) else result

    return safe


def smoke_code(source: str) -> list[str]:
    """加载并用几种典型输入试跑，确认它返回字符串、不吞掉内容。"""
    errors = check_code(source)
    if errors:
        return errors
    scope: dict[str, Any] = {}
    try:
        exec(compile(source, "<harness>", "exec"), scope)  # noqa: S102
        fn = scope["transform_result"]
        for name, args, result in [("read_file", {"path": "a.py"}, "    1\tx = 1"),
                                   ("run_command", {"command": "pytest -q"}, "[退出码 1]\n" + "E   assert 1 == 2\n" * 50),
                                   ("write_file", {"path": "a.py", "content": "x"}, "已写入 a.py（1 行）。"),
                                   ("search_text", {"pattern": "x"}, "")]:
            out = fn(name, args, result)
            if not isinstance(out, str):
                return [f"transform_result 对 {name} 返回的不是字符串"]
            if result and not out:
                return [f"transform_result 把 {name} 的结果清空了"]
    except Exception as e:
        return [f"试跑出错：{type(e).__name__}: {e}"]
    return []


def result_hook(config: dict[str, Any], code: str) -> Callable[[str, dict, str], str]:
    """把配置里的截断、编辑后提醒，和外壳代码的 transform_result 串成一个钩子。"""
    cfg = effective_config(config)
    custom = load_hook(code) if code.strip() else None

    def hook(name: str, args: dict, result: str) -> str:
        if custom:
            result = custom(name, args, result)
        result = clip(result, cfg["tools.result_limit"])
        if name in ("write_file", "edit_file") and cfg["reminders.after_edit"]:
            result += f"\n（提示：{cfg['reminders.after_edit']}）"
        return result

    return hook
