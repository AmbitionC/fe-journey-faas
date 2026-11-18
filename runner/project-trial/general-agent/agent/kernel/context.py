"""上下文管理器：三道防线里的后两道。第一道（结果进上下文前截断）在工具注册表里。"""
from __future__ import annotations

from dataclasses import dataclass

from ..model import ModelClient
from ..types import Message, Usage

PLACEHOLDER = "[此处是 {what} 的结果，已清理以节省空间。需要时请重新获取。]"

SUMMARY_PROMPT = """下面是一段较早的对话记录，请把它压缩成一份交接摘要，供你自己继续工作时使用。必须保留：
1. 用户最初的任务，以及中途追加的要求。
2. 已经完成了什么，改了哪些文件。
3. 试过但失败的做法，以及失败原因。
4. 当前正在做的一步和接下来的打算。
5. 用户表达过的偏好和明确的禁止事项，原话保留。
只输出摘要本身，不要寒暄。"""


def estimate_tokens(messages: list[Message]) -> int:
    """粗略估算：只用来决定要不要提前压缩，不能用来计费。"""
    chars = sum(len(m.content) + sum(len(str(c.arguments)) + len(c.name) for c in m.tool_calls) for m in messages)
    return chars // 2  # 中英混合文本，按两个字符一个 token 偏保守地估


def safe_split_point(messages: list[Message], target: int) -> int:
    """从 target 往前找第一个可以安全切开的位置：不能拆散一对工具调用和它的结果。"""
    i = min(target, len(messages) - 1)
    while i > 0:
        m = messages[i]
        if m.role != "tool" and not messages[i - 1].tool_calls:
            return i
        i -= 1
    return 0


@dataclass
class ContextManager:
    window_tokens: int = 64_000
    threshold: float = 0.8  # 留出余量放模型的下一次回复
    keep_recent: int = 8  # 最近若干条消息原样保留
    summarizer: ModelClient | None = None

    def __post_init__(self) -> None:
        self.last_input_tokens = 0  # 模型接口返回的真实用量，最可靠
        self.stats = {"cleared": 0, "compactions": 0}

    def observe(self, usage: Usage) -> None:
        self.last_input_tokens = usage.input

    def _over(self, messages: list[Message]) -> bool:
        # 上一次的真实用量覆盖不到之后新增的消息，所以两个数取大的
        return max(self.last_input_tokens, estimate_tokens(messages)) > self.window_tokens * self.threshold

    async def prepare(self, messages: list[Message]) -> list[Message]:
        """返回本轮发给模型的消息列表。可能就地改写 messages（清理、压缩）。"""
        if not self._over(messages):
            return messages
        self._clear_old_tool_results(messages)
        self.last_input_tokens = 0  # 清理之后旧的真实用量已不适用，回到估算
        if self._over(messages) and self.summarizer is not None:
            await self._compact(messages)
        return messages

    # --- 第二道：清理旧的工具结果正文，保留调用记录 ----------------------
    def _clear_old_tool_results(self, messages: list[Message]) -> None:
        names = {c.id: f'{c.name}({_brief(c.arguments)})' for m in messages for c in m.tool_calls}
        for m in messages[: max(0, len(messages) - self.keep_recent)]:
            if m.role == "tool" and len(m.content) > 200 and not m.content.startswith("[此处是"):
                m.content = PLACEHOLDER.format(what=names.get(m.tool_call_id or "", "一次工具调用"))
                self.stats["cleared"] += 1

    # --- 第三道：把早期对话压缩成摘要 -----------------------------------
    async def _compact(self, messages: list[Message]) -> None:
        split = safe_split_point(messages, len(messages) - self.keep_recent)
        if split <= 1:
            return
        head, early = messages[0], messages[1:split]
        transcript = "\n".join(_render(m) for m in early)
        reply, _ = await self.summarizer.chat(
            [Message("system", SUMMARY_PROMPT), Message("user", transcript)], [])
        summary = Message("user", f"[以下是更早对话的摘要，原文已省略]\n{reply.content}")
        messages[:] = [head, summary] + messages[split:]
        self.stats["compactions"] += 1


def _brief(arguments: dict) -> str:
    return ", ".join(f'{k}="{str(v)[:60]}"' for k, v in list(arguments.items())[:2])


def _render(m: Message) -> str:
    if m.tool_calls:
        calls = "; ".join(f"{c.name}({_brief(c.arguments)})" for c in m.tool_calls)
        return f"[助手] {m.content} 调用工具：{calls}"
    label = {"user": "用户", "assistant": "助手", "tool": "工具结果", "system": "系统"}[m.role]
    return f"[{label}] {m.content[:2000]}"
