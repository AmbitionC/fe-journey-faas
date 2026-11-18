"""执行循环：拼上下文、调模型、过权限、执行工具、追加结果，直到模型不再要求调用工具。"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Callable, Literal

from ..model import ModelClient, ModelError
from ..state.session import Session
from ..tools.registry import ToolRegistry
from ..types import Event, Message, ToolCall, Usage
from .context import ContextManager
from .permission import PermissionGate

Stopped = Literal["finished", "max_turns", "interrupted", "model_error"]
EventSink = Callable[[Event], None]

WRAP_UP = ("已达到本次任务的轮次上限。请不要再调用任何工具，直接用文字总结："
           "已经完成了什么、还剩什么没做、你建议用户下一步做什么。")
REPEAT_HINT = ("你已经连续多次用完全相同的参数调用同一个工具，结果不会变化。"
               "请换一种做法，或者说明卡在了哪里。")


@dataclass
class Outcome:
    text: str
    stopped: Stopped
    turns: int
    usage: Usage = field(default_factory=Usage)
    messages: list[Message] = field(default_factory=list)


class Agent:
    def __init__(self, model: ModelClient, registry: ToolRegistry, gate: PermissionGate,
                 system_prompt: str, session: Session | None = None,
                 on_event: EventSink | None = None, max_turns: int = 40,
                 max_retries: int = 3, retry_base_delay: float = 1.0, repeat_limit: int = 3,
                 context: ContextManager | None = None, depth: int = 0):
        self.model = model
        self.registry = registry
        self.gate = gate
        self.session = session or Session(None)
        self.emit: EventSink = on_event or (lambda e: None)
        self.max_turns = max_turns
        self.max_retries = max_retries
        self.retry_base_delay = retry_base_delay
        self.repeat_limit = repeat_limit
        self.context = context
        self.depth = depth  # 0 是主任务，子任务是 1
        self.messages: list[Message] = []
        self._append(Message("system", system_prompt))
        self._recent: list[str] = []
        self._interrupt = asyncio.Event()

    def interrupt(self) -> None:
        """用户按了中断键。当前这一步做完后退出，会话记录保持完整。"""
        self._interrupt.set()

    # --- 主循环 ---------------------------------------------------------
    async def run(self, task: str) -> Outcome:
        self._interrupt.clear()
        self._append(Message("user", task))
        usage = Usage()
        turns = 0
        while True:
            if self._interrupt.is_set():
                return self._finish("（已被用户中断）", "interrupted", turns, usage)
            wrapping_up = turns >= self.max_turns
            if wrapping_up:
                self._append(Message("user", WRAP_UP))
            try:
                reply, used = await self._call_model(tools=not wrapping_up)
            except ModelError as e:
                return self._finish(f"模型接口不可用，任务中止：{e}", "model_error", turns, usage)
            usage.add(used)
            turns += 1
            self._append(reply)
            if wrapping_up:
                return self._finish(reply.content, "max_turns", turns, usage)
            if not reply.tool_calls:
                return self._finish(reply.content, "finished", turns, usage)
            for msg in await self._execute_batch(reply.tool_calls):
                self._append(msg)
            if self._stuck(reply.tool_calls):
                self._append(Message("user", REPEAT_HINT))

    async def _call_model(self, tools: bool) -> tuple[Message, Usage]:
        """接口报错或超时按指数退避重试，超过上限才向上抛。"""
        if self.context:
            await self.context.prepare(self.messages)
        attempt = 0
        while True:
            try:
                reply, used = await self.model.chat(
                    self.messages, self.registry.schemas() if tools else [],
                    on_text=lambda t: self.emit(Event("text_delta", {"text": t})))
                if self.context:
                    self.context.observe(used)
                return reply, used
            except ModelError as e:
                attempt += 1
                if not e.retryable or attempt > self.max_retries:
                    raise
                await asyncio.sleep(self.retry_base_delay * 2 ** (attempt - 1))

    # --- 工具执行 -------------------------------------------------------
    async def _execute_batch(self, calls: list[ToolCall]) -> list[Message]:
        """只读的工具并行执行，会改东西的按顺序执行。结果顺序始终和调用顺序一致。"""
        tools = [self.registry.get(c.name) for c in calls]
        if all(t is not None and t.read_only for t in tools):
            results = await asyncio.gather(*(self._guarded_execute(c) for c in calls))
        else:
            results = [await self._guarded_execute(c) for c in calls]
        return [Message("tool", r, tool_call_id=c.id) for c, r in zip(calls, results)]

    async def _guarded_execute(self, call: ToolCall) -> str:
        """过权限闸门、带超时地执行、把异常转成文字。"""
        problem = self.registry.validate(call)
        if problem:
            return problem
        tool = self.registry.get(call.name)
        verdict = await self.gate.check(tool, call)
        if not verdict.allowed:
            self.session.note("tool_denied", id=call.id, name=call.name, reason=verdict.reason)
            self.emit(Event("tool_end", {"id": call.id, "name": call.name, "denied": True, "result": verdict.reason}))
            return verdict.reason
        self.session.note("tool_start", id=call.id, name=call.name, arguments=call.arguments)
        self.emit(Event("tool_start", {"id": call.id, "name": call.name, "arguments": call.arguments}))
        result = await self.registry.execute(call)
        self.emit(Event("tool_end", {"id": call.id, "name": call.name, "denied": False, "result": result}))
        return result

    def _stuck(self, calls: list[ToolCall]) -> bool:
        """重复调用检测：连续若干轮的调用完全相同。"""
        sig = json.dumps([[c.name, c.arguments] for c in calls], sort_keys=True, ensure_ascii=False)
        self._recent = (self._recent + [sig])[-self.repeat_limit:]
        return len(self._recent) == self.repeat_limit and len(set(self._recent)) == 1

    # --- 记录 -----------------------------------------------------------
    def _append(self, m: Message) -> None:
        self.messages.append(m)
        self.session.message(m)

    def _finish(self, text: str, stopped: Stopped, turns: int, usage: Usage) -> Outcome:
        self.session.note("done", stopped=stopped, turns=turns, input_tokens=usage.input, output_tokens=usage.output)
        self.emit(Event("done", {"stopped": stopped, "turns": turns}))
        return Outcome(text=text, stopped=stopped, turns=turns, usage=usage, messages=list(self.messages))
