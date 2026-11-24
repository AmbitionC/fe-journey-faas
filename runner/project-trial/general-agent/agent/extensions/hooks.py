"""钩子：在工具执行前后跑一条你自己写的命令。

权限闸门回答“这一步让不让做”，规则是通用的。钩子回答的是项目自己的事：
改完 Python 文件自动跑一遍格式化、禁止改某个目录、每次执行命令都记一笔审计日志。
这些事写进提示词只是“希望模型照做”，写成钩子是“一定会发生”。

配置在项目目录的 .agent/hooks.json：
{"pre_tool":  [{"tool": "write_file", "command": "python scripts/guard.py"}],
 "post_tool": [{"tool": "edit_file",  "command": "ruff check --quiet $HOOK_PATH"}]}

命令从标准输入收到一段 JSON（工具名、参数、post_tool 还有结果）。
pre_tool 的命令以退出码 2 结束表示拦下这一步，标准错误里的话会作为原因交给模型；其他退出码不拦。
post_tool 的命令输出会接在工具结果后面交给模型，例如把检查出来的问题告诉它。
钩子是用户写的配置，不是模型的输出，所以不过权限闸门；也正因为如此，不要让 Agent 有权改 hooks.json。
"""
from __future__ import annotations

import asyncio
import fnmatch
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from ..types import ToolCall

BLOCK = 2


@dataclass
class Hook:
    tool: str       # 工具名，支持通配，"*" 表示所有工具
    command: str


@dataclass
class Hooks:
    cwd: Path
    pre_tool: list[Hook] = field(default_factory=list)
    post_tool: list[Hook] = field(default_factory=list)
    timeout: float = 30

    @classmethod
    def load(cls, cwd: Path) -> "Hooks | None":
        path = cwd / ".agent" / "hooks.json"
        if not path.is_file():
            return None
        raw = json.loads(path.read_text(encoding="utf-8"))
        make = lambda key: [Hook(h.get("tool", "*"), h["command"]) for h in raw.get(key, []) if h.get("command")]  # noqa: E731
        return cls(cwd, make("pre_tool"), make("post_tool"))

    async def _run(self, hook: Hook, payload: dict) -> tuple[int, str, str]:
        env = {**os.environ, "HOOK_TOOL": payload["tool"], "HOOK_PATH": str(payload["arguments"].get("path", ""))}
        proc = await asyncio.create_subprocess_shell(
            hook.command, cwd=self.cwd, env=env, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(json.dumps(payload, ensure_ascii=False).encode()),
                                              self.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return 1, "", f"钩子超过 {self.timeout:g} 秒没有结束"
        return proc.returncode or 0, out.decode(errors="replace").strip(), err.decode(errors="replace").strip()

    async def before(self, call: ToolCall) -> str | None:
        """返回拦下的原因；不拦返回 None。"""
        for hook in self.pre_tool:
            if fnmatch.fnmatchcase(call.name, hook.tool):
                code, _, err = await self._run(hook, {"tool": call.name, "arguments": call.arguments})
                if code == BLOCK:
                    return (f"这次操作被项目的钩子拦下了：{err or '钩子没有说明原因'}\n"
                            "请不要重试同样的操作，换一种方式继续，或者向用户说明情况。")
        return None

    async def after(self, call: ToolCall, result: str) -> str:
        for hook in self.post_tool:
            if fnmatch.fnmatchcase(call.name, hook.tool):
                code, out, err = await self._run(hook, {"tool": call.name, "arguments": call.arguments, "result": result})
                note = "\n".join(x for x in (out, err if code else "") if x)
                if note:
                    result += f"\n\n[钩子 {hook.command.split()[0]} 的输出]\n{note[:2000]}"
        return result
