"""把各部件装配成一个可运行的 Agent。终端、无界面评测、网页试用都从这里拿同一个内核。"""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Callable

from .extensions.hooks import Hooks
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
from .types import Tool

# 工具返回结果后的加工钩子：(工具名, 参数, 原结果) -> 交给模型的结果
ResultHook = Callable[[str, dict, str], str]


def build_coding_agent(model: ModelClient, cwd: str | Path, *, rules: list[Rule] | None = None,
                       asker: Asker | None = None, headless: bool = False,
                       session_file: str | Path | None = None, on_event: EventSink | None = None,
                       max_turns: int = 40, command_timeout: int = 120,
                       window_tokens: int = 64_000, memory_db: str | Path | None = None,
                       home: Path | None = None, subagents: bool = True,
                       executor: Executor | None = None, system_prompt: str | None = None,
                       extra_system: str = "", enabled_tools: list[str] | None = None,
                       result_hook: ResultHook | None = None, hooks: bool = False) -> Agent:
    """后四个参数是给评测与自进化平台留的口子：换系统提示词、追加一段内容（经验手册）、
    限定工具集、加工工具结果。不传时行为和原来完全一样。
    hooks=True 时读取项目的 .agent/hooks.json。默认不读：钩子会在本机执行命令，
    只有用户自己在终端里启动时才打开，评测和线上试用不打开。"""
    ws = Workspace(cwd)
    registry = ToolRegistry(timeout=command_timeout + 30)

    def register(t: Tool) -> None:
        if enabled_tools is not None and t.name not in enabled_tools and t.name != "read_file":
            return
        if result_hook is not None:
            original = t.run

            async def run(*args, _name=t.name, _original=original, **kwargs) -> str:
                return result_hook(_name, kwargs, await _original(*args, **kwargs))

            t = replace(t, run=run)
        registry.register(t)

    for t in file_tools(ws):
        register(t)
    register(shell_tool(ws, default_timeout=command_timeout, executor=executor))
    gate = PermissionGate(ws, rules=rules, asker=asker, headless=headless)

    # 系统提示词之后依次是项目说明和记忆标题：都是稳定内容，放在前面能命中缓存
    system = (system_prompt or CODING_SYSTEM_PROMPT).replace("{cwd}", str(ws.root))
    if extra_system:
        system += f"\n{extra_system}\n"
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
                 max_turns=max_turns, context=context(), hooks=Hooks.load(ws.root) if hooks else None)
