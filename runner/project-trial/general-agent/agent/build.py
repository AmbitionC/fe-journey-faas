"""把各部件装配成一个可运行的 Agent。终端、无界面评测、网页试用都从这里拿同一个内核。"""
from __future__ import annotations

from pathlib import Path

from .extensions.skills import discover, skill_tool, skills_index
from .kernel.context import ContextManager
from .kernel.loop import Agent, EventSink
from .kernel.permission import Asker, PermissionGate, Rule
from .kernel.subagent import SubagentScheduler
from .model import ModelClient
from .prompts import CODING_SYSTEM_PROMPT
from .state.memory import MemoryStore, load_instructions, memory_tools
from .state.session import Session
from .tools.coding.files import file_tools
from .tools.coding.shell import Executor, shell_tool
from .tools.coding.workspace import Workspace
from .tools.registry import ToolRegistry


def build_coding_agent(model: ModelClient, cwd: str | Path, *, rules: list[Rule] | None = None,
                       asker: Asker | None = None, headless: bool = False,
                       session_file: str | Path | None = None, on_event: EventSink | None = None,
                       max_turns: int = 40, command_timeout: int = 120,
                       window_tokens: int = 64_000, memory_db: str | Path | None = None,
                       home: Path | None = None, subagents: bool = True,
                       executor: Executor | None = None) -> Agent:
    ws = Workspace(cwd)
    registry = ToolRegistry(timeout=command_timeout + 30)
    for t in file_tools(ws):
        registry.register(t)
    registry.register(shell_tool(ws, default_timeout=command_timeout, executor=executor))
    gate = PermissionGate(ws, rules=rules, asker=asker, headless=headless)

    # 系统提示词之后依次是项目说明和记忆标题：都是稳定内容，放在前面能命中缓存
    system = CODING_SYSTEM_PROMPT.format(cwd=ws.root)
    instructions = load_instructions(ws.root, home)
    if instructions:
        system += f"\n# 项目说明\n{instructions}\n"
    if memory_db:
        store = MemoryStore(memory_db, scope=str(ws.root))
        for t in memory_tools(store):
            registry.register(t)
        index = store.index()
        if index:
            system += f"\n# 长期记忆（只有标题，相关时用 recall 取正文）\n{index}\n"

    skills = discover(ws.root / ".agent" / "skills")
    if skills:
        registry.register(skill_tool(skills, ws.root))
        system += f"\n# 技能（只有简介，任务匹配时先用 load_skill 读入全文）\n{skills_index(skills)}\n"

    def context() -> ContextManager:
        return ContextManager(window_tokens=window_tokens, summarizer=model)

    if subagents:
        def make_sub(sub_registry: ToolRegistry, prompt: str, depth: int) -> Agent:
            # 子任务与主任务共用同一个闸门，没有例外
            return Agent(model, sub_registry, gate, prompt, max_turns=30, context=context(), depth=depth,
                         on_event=None)

        scheduler = SubagentScheduler(make_sub, registry)
        registry.register(scheduler.as_tool(depth=0))

    return Agent(model, registry, gate, system, session=Session(session_file), on_event=on_event,
                 max_turns=max_turns, context=context())
