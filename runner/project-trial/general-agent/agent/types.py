"""全系统只流转这一种消息格式，和 OpenAI 兼容接口保持一致。"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class Message:
    role: Literal["system", "user", "assistant", "tool"]
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)  # 仅 assistant
    tool_call_id: str | None = None  # 仅 tool
    reasoning: str = ""  # 思考内容。部分模型（如 DeepSeek 思考模式）要求带工具调用的回复原样回传它

    def to_api(self) -> dict[str, Any]:
        d: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.tool_calls:
            d["tool_calls"] = [
                {
                    "id": c.id,
                    "type": "function",
                    "function": {"name": c.name, "arguments": json.dumps(c.arguments, ensure_ascii=False)},
                }
                for c in self.tool_calls
            ]
        if self.tool_call_id:
            d["tool_call_id"] = self.tool_call_id
        if self.reasoning:
            d["reasoning_content"] = self.reasoning
        return d

    @classmethod
    def from_api(cls, d: dict[str, Any]) -> "Message":
        calls = []
        for c in d.get("tool_calls") or []:
            raw = c["function"].get("arguments") or "{}"
            try:
                args = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError:
                # 参数不是合法 JSON 时原样带回，由注册表给出可读的报错
                args = {"__raw__": raw}
            calls.append(ToolCall(id=c["id"], name=c["function"]["name"], arguments=args))
        return cls(role=d["role"], content=d.get("content") or "", tool_calls=calls,
                   tool_call_id=d.get("tool_call_id"), reasoning=d.get("reasoning_content") or "")


@dataclass
class Usage:
    input: int = 0
    output: int = 0

    def add(self, other: "Usage") -> None:
        self.input += other.input
        self.output += other.output


@dataclass
class Tool:
    name: str
    description: str  # 写给模型看的用途说明
    parameters: dict[str, Any]  # JSON Schema
    run: Callable[..., Awaitable[str]]
    read_only: bool = False  # 决定能否并行、是否默认放行


@dataclass
class Event:
    kind: Literal["text_delta", "tool_delta", "tool_start", "tool_end", "ask_permission", "done"]
    data: dict[str, Any]
