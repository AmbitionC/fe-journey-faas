"""子任务调度器：一个全新的执行循环，结束后只把最后一段文字交回主任务。"""
from __future__ import annotations

import asyncio
from typing import Callable

from ..tools.registry import ToolRegistry, tool
from ..types import Tool
from .loop import Agent

SUBAGENT_PROMPT = """你是被派来完成一项独立子任务的助手。你看不到派发者之前的任何对话，任务说明就是你知道的全部。

要求：
- 只做任务说明里要求的事。你只有只读工具，不能修改任何文件。
- 最后一条回复就是交回去的全部内容：先给结论，再给依据。
- 引用代码时带文件路径和行号。
- 没找到就明确说没找到，并说明找过哪些地方。不要编造看似合理的答案。
"""

AgentFactory = Callable[[ToolRegistry, str, int], Agent]


class SubagentScheduler:
    def __init__(self, make_agent: AgentFactory, parent_registry: ToolRegistry,
                 max_parallel: int = 3, max_depth: int = 1):
        self.make_agent = make_agent
        self.parent_registry = parent_registry
        self.max_depth = max_depth
        self._semaphore = asyncio.Semaphore(max_parallel)
        self.spawned = 0

    def _explore_registry(self) -> ToolRegistry:
        """探索类子任务只给只读工具：不能改文件，也就不需要弹确认。"""
        sub = ToolRegistry(timeout=self.parent_registry.timeout)
        for name in self.parent_registry.names():
            t = self.parent_registry.get(name)
            if t.read_only and t.name != "spawn_subagent":
                sub.register(t)
        return sub

    async def spawn(self, task: str, parent_depth: int) -> str:
        if parent_depth >= self.max_depth:
            return "子任务不能再派发子任务。请直接完成这项工作。"
        async with self._semaphore:
            self.spawned += 1
            agent = self.make_agent(self._explore_registry(), SUBAGENT_PROMPT, parent_depth + 1)
            try:
                outcome = await agent.run(task)
            except Exception as e:  # 一个子任务失败不能拖垮其他的
                return f"子任务执行失败：{type(e).__name__}: {e}"
            if outcome.stopped != "finished":
                return f"子任务没有正常结束（{outcome.stopped}）。它最后的说明：{outcome.text}"
            return outcome.text

    def as_tool(self, depth: int = 0) -> Tool:
        scheduler = self

        @tool(read_only=True)  # 只读：模型一次发出多个派发时可以并行
        async def spawn_subagent(task: str) -> str:
            """派发一个只读的子任务去独立完成一项查找或调研，返回它的结论。

            适合：在大仓库里定位一段逻辑、几个互不依赖的问题、过程冗长但结论简短的工作。
            不适合：修改代码、两三步就能做完的小事（子任务有固定开销，小事派出去更慢更贵）。
            子任务看不到当前对话，任务说明必须自己就能读懂：要回答什么问题、已经知道什么、
            希望以什么形式返回。子任务给出的位置，据此修改之前要自己读一遍确认。

            Args:
                task: 完整的任务说明
            """
            return await scheduler.spawn(task, depth)

        return spawn_subagent
