"""被测对象的适配器，以及平台自己用的文本模型封装。

GeneralAgentAdapter 把第一个项目（从零手写通用 Agent）的无界面模式接进来。
接别的 Agent 时照着写一个 run() 即可。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .harness import effective_config, result_hook
from .types import AgentVersion, RunOutput, Usage


def render_playbook(version: AgentVersion) -> str:
    if not version.playbook:
        return ""
    lines = ["# 经验手册（以往任务里总结出来的做法）"]
    for section in dict.fromkeys(i.section for i in version.playbook):
        lines.append(f"## {section}")
        lines += [f"- [{i.id}] {i.content}" for i in version.playbook if i.section == section]
    return "\n".join(lines)


class GeneralAgentAdapter:
    def __init__(self, model: Any, command_timeout: int = 60, executor: Any = None):
        self.model, self.command_timeout, self.executor = model, command_timeout, executor

    async def run(self, task_prompt: str, workdir: Path, version: AgentVersion, allow: list[str]) -> RunOutput:
        from agent.build import build_coding_agent          # 第一个项目的包
        from agent.kernel.permission import Rule

        cfg = effective_config(version.config_dict)
        rules = [Rule("run_command", p, "allow") for p in allow] + \
                [Rule(t, "*", "allow") for t in ("write_file", "edit_file")]
        agent = build_coding_agent(
            self.model, workdir, rules=rules, headless=True, home=workdir.parent, subagents=False,
            max_turns=cfg["loop.max_turns"], command_timeout=self.command_timeout, executor=self.executor,
            system_prompt=version.system_prompt, extra_system=render_playbook(version),
            enabled_tools=cfg["tools.enabled"], result_hook=result_hook(version.config_dict, version.code))
        outcome = await agent.run(task_prompt)
        return RunOutput(outcome.text, [m.to_api() for m in outcome.messages],
                         Usage(outcome.usage.input, outcome.usage.output), outcome.stopped, outcome.turns)


class ChatTextModel:
    """把第一个项目的模型客户端包成 ask(system, user) -> str。"""

    def __init__(self, model: Any):
        self.model = model
        self.usage = Usage()

    async def ask(self, system: str, user: str) -> str:
        from agent.types import Message
        reply, usage = await self.model.chat([Message("system", system), Message("user", user)], [])
        self.usage.input += usage.input
        self.usage.output += usage.output
        return reply.content


class ScriptedTextModel:
    """按顺序返回预先写好的文本，测试用。"""

    def __init__(self, replies: list[str]):
        self.replies, self.seen = list(replies), []

    async def ask(self, system: str, user: str) -> str:
        self.seen.append((system, user))
        return self.replies.pop(0) if self.replies else ""
