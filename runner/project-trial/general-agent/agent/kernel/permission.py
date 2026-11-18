"""权限闸门：拒绝规则优先于放行规则，规则优先于默认行为。"""
from __future__ import annotations

import fnmatch
import re
import shlex
from dataclasses import dataclass
from typing import Awaitable, Callable, Literal

from ..tools.coding.workspace import PathError, Workspace
from ..types import Tool, ToolCall

Decision = Literal["allow", "deny", "ask"]


@dataclass
class Rule:
    tool: str  # 工具名，如 "run_command"；"*" 表示任意工具
    pattern: str  # 对关键参数的通配匹配，如 "pytest *"
    decision: Literal["allow", "deny"]


@dataclass
class Verdict:
    allowed: bool
    reason: str = ""


@dataclass
class Answer:
    choice: Literal["once", "always", "deny"]
    note: str = ""  # 拒绝时用户补充的一句话


Asker = Callable[[ToolCall, str], Awaitable[Answer]]

KEY_ARG = {"run_command": "command", "read_file": "path", "write_file": "path", "edit_file": "path"}
_SPLIT = re.compile(r"&&|\|\||;|\||\n")
_SUBSTITUTION = re.compile(r"\$\(|`")


def split_command(command: str) -> list[str]:
    """按 &&、||、;、| 拆成若干段，每一段分别判定。"""
    return [seg.strip() for seg in _SPLIT.split(command) if seg.strip()]


def builtin_deny(segment: str) -> str | None:
    """内置拒绝：按命令名和参数集合判断，不按字符串。rm -rf 和 rm -fr 是同一件事。"""
    try:
        words = shlex.split(segment)
    except ValueError:
        return None
    while words and words[0] in ("sudo", "env", "nohup", "time"):
        words = words[1:]
    if not words:
        return None
    cmd, args = words[0].rsplit("/", 1)[-1], words[1:]
    flags = {c for a in args if a.startswith("-") and not a.startswith("--") for c in a[1:]}
    long_flags = {a for a in args if a.startswith("--")}
    targets = [a for a in args if not a.startswith("-")]
    if cmd == "rm" and ("r" in flags or "R" in flags or "--recursive" in long_flags):
        if any(t in ("/", "/*", "~", "~/", "$HOME", ".", "..", "*") or t.startswith("/") for t in targets):
            return "递归删除项目之外或整个目录"
    if cmd in ("mkfs", "fdisk", "shutdown", "reboot", "halt", "poweroff") or cmd.startswith("mkfs."):
        return "改写磁盘或关机"
    if cmd == "dd" and any(a.startswith("of=/dev/") for a in args):
        return "直接写磁盘设备"
    return None


class PermissionGate:
    def __init__(self, workspace: Workspace, rules: list[Rule] | None = None,
                 asker: Asker | None = None, headless: bool = False):
        self.ws = workspace
        self.project_rules = list(rules or [])
        self.session_rules: list[Rule] = []  # 本次会话里用户新同意的，退出即失效
        self.asker = asker
        self.headless = headless

    # --- 规则匹配 -------------------------------------------------------
    def _match(self, tool: str, value: str, decision: str) -> bool:
        return any(r.decision == decision and r.tool in (tool, "*") and fnmatch.fnmatchcase(value, r.pattern)
                   for r in self.project_rules + self.session_rules)

    def _decide_value(self, tool: str, value: str) -> Decision:
        if self._match(tool, value, "deny"):
            return "deny"
        if self._match(tool, value, "allow"):
            return "allow"
        return "ask"

    def decide(self, tool: Tool, call: ToolCall) -> tuple[Decision, str]:
        value = str(call.arguments.get(KEY_ARG.get(call.name, ""), ""))
        if call.name == "run_command":
            return self._decide_command(value)
        if call.name in ("read_file", "write_file", "edit_file"):
            try:
                self.ws.resolve(value)
            except PathError as e:
                return "deny", str(e)
            if self.ws.is_sensitive(value):
                d = self._decide_value(call.name, value)
                return (d, "敏感文件") if d != "allow" else ("allow", "")
        d = self._decide_value(call.name, value)
        if d == "deny":
            return "deny", "命中拒绝规则"
        if d == "allow" or tool.read_only:
            return "allow", ""
        return "ask", ""

    def _decide_command(self, command: str) -> tuple[Decision, str]:
        segments = split_command(command)
        for seg in segments:
            why = builtin_deny(seg)
            if why:
                return "deny", f"内置拒绝规则：{why}"
            if self._match("run_command", seg, "deny"):
                return "deny", f"命中拒绝规则：{seg}"
        if _SUBSTITUTION.search(command):
            return "ask", "命令里有命令替换，无法静态判断会执行什么"
        # 任何一段需要确认，则整条需要确认
        if segments and all(self._match("run_command", seg, "allow") for seg in segments):
            return "allow", ""
        return "ask", ""

    # --- 对外入口 -------------------------------------------------------
    async def check(self, tool: Tool, call: ToolCall) -> Verdict:
        decision, reason = self.decide(tool, call)
        if decision == "allow":
            return Verdict(True)
        shown = _describe(call)
        if decision == "deny":
            return Verdict(False, f"这次操作被拒绝：{shown}\n原因：{reason}\n请不要重试同样的操作，换一种方式继续，或者向用户说明情况。")
        if self.headless or self.asker is None:
            return Verdict(False, f"这次操作需要用户确认，但当前是无界面模式，已视为拒绝：{shown}\n请换一种不需要确认的方式继续，或者说明无法完成的原因。")
        answer = await self.asker(call, reason)
        if answer.choice == "deny":
            note = f"\n用户说明：{answer.note}" if answer.note else ""
            return Verdict(False, f"用户拒绝了这次操作：{shown}{note}\n请不要重试同样的操作，换一种方式继续，或者向用户说明情况。")
        if answer.choice == "always":
            self.session_rules.extend(_rules_for(call))
        return Verdict(True)


def _describe(call: ToolCall) -> str:
    value = call.arguments.get(KEY_ARG.get(call.name, ""), "")
    return f'{call.name}("{value}")' if value else call.name


def _rules_for(call: ToolCall) -> list[Rule]:
    """“以后同类不再问”：命令按每一段的命令名放行，文件按具体路径放行。"""
    if call.name == "run_command":
        rules = []
        for seg in split_command(str(call.arguments.get("command", ""))):
            head = seg.split()[0]
            rules += [Rule("run_command", head, "allow"), Rule("run_command", f"{head} *", "allow")]
        return rules
    key = KEY_ARG.get(call.name)
    return [Rule(call.name, str(call.arguments.get(key, "*")) if key else "*", "allow")]
