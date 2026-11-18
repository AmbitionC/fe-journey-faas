"""工具注册表：查找、校验参数、带超时执行、截断结果。永远只返回字符串，不向上抛异常。"""
from __future__ import annotations

import asyncio
import inspect
import re
from typing import Any, Callable, get_args, get_origin, get_type_hints

from ..types import Tool, ToolCall

MAX_RESULT_CHARS = 12_000
_JSON_TYPES = {str: "string", int: "integer", float: "number", bool: "boolean", list: "array", dict: "object"}
_PY_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict}


def tool(read_only: bool = False, name: str | None = None) -> Callable[[Callable], Tool]:
    """用函数签名和文档字符串生成工具定义。文档字符串的 Args 段是各参数的说明。"""

    def wrap(fn: Callable) -> Tool:
        doc = inspect.getdoc(fn) or ""
        head, _, args_doc = doc.partition("Args:")
        arg_desc = {m.group(1): m.group(2).strip()
                    for m in re.finditer(r"^\s*(\w+):\s*(.+)$", args_doc, re.MULTILINE)}
        hints = get_type_hints(fn)
        props: dict[str, Any] = {}
        required: list[str] = []
        for pname, p in inspect.signature(fn).parameters.items():
            if pname.startswith("_"):
                continue  # 下划线开头的参数由运行环境注入，不暴露给模型
            hint = hints.get(pname, str)
            base = get_origin(hint) or hint
            props[pname] = {"type": _JSON_TYPES.get(base, "string"), "description": arg_desc.get(pname, "")}
            if base is list and get_args(hint):
                props[pname]["items"] = {"type": _JSON_TYPES.get(get_args(hint)[0], "string")}
            if p.default is inspect.Parameter.empty:
                required.append(pname)
        schema = {"type": "object", "properties": props, "required": required}
        return Tool(name=name or fn.__name__, description=head.strip(), parameters=schema,
                    run=fn, read_only=read_only)

    return wrap


def truncate(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    """保留开头和结尾，中间说明省略了多少。报错信息通常在结尾。"""
    if len(text) <= limit:
        return text
    head, tail = limit * 2 // 3, limit // 3
    omitted = len(text) - head - tail
    return f"{text[:head]}\n……（中间省略 {omitted} 个字符，可缩小范围后重新获取）……\n{text[-tail:]}"


class ToolRegistry:
    def __init__(self, timeout: float = 150):
        self._tools: dict[str, Tool] = {}
        self.timeout = timeout

    def register(self, t: Tool) -> None:
        self._tools[t.name] = t

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def names(self) -> list[str]:
        return sorted(self._tools)

    def schemas(self) -> list[dict[str, Any]]:
        return [{"type": "function",
                 "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}
                for t in self._tools.values()]

    def validate(self, call: ToolCall) -> str | None:
        """返回 None 表示参数合格，否则返回写给模型看的错误说明。"""
        t = self._tools.get(call.name)
        if t is None:
            return f"没有名为 {call.name} 的工具。可用的工具有：{', '.join(self.names())}"
        if "__raw__" in call.arguments:
            return f"工具 {call.name} 的参数不是合法的 JSON：{str(call.arguments['__raw__'])[:200]}"
        props = t.parameters.get("properties", {})
        for req in t.parameters.get("required", []):
            if req not in call.arguments:
                return f"工具 {call.name} 缺少必填参数 {req}（{props[req].get('description', '')}）"
        for key, value in call.arguments.items():
            if key not in props:
                return f"工具 {call.name} 没有参数 {key}。可用的参数有：{', '.join(props)}"
            expected = props[key]["type"]
            py = _PY_TYPES[expected]
            if not isinstance(value, py) or (expected in ("integer", "number") and isinstance(value, bool)):
                return f"工具 {call.name} 的参数 {key} 应为 {expected}，收到的是 {type(value).__name__}"
        return None

    async def execute(self, call: ToolCall) -> str:
        problem = self.validate(call)
        if problem:
            return problem
        t = self._tools[call.name]
        try:
            result = await asyncio.wait_for(t.run(**call.arguments), timeout=self.timeout)
        except asyncio.TimeoutError:
            return f"工具 {call.name} 执行超过 {self.timeout:.0f} 秒，已中止。"
        except Exception as e:  # 工具出错不是程序出错，变成文字交回模型
            return f"工具 {call.name} 执行出错：{type(e).__name__}: {e}"
        return truncate(str(result))
