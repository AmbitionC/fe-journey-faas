"""模型接口。内核只依赖 ModelClient 这个协议，换模型只改配置。"""
from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable, Protocol

from .types import Message, ToolCall, Usage

TextSink = Callable[[str], None]
# 工具调用的参数还在生成时的进度：(第几个调用, 工具名, 新到的一段参数原文)
ToolSink = Callable[[int, str, str], None]


class ModelError(Exception):
    """模型接口不可用。只有它会让执行循环重试或中断。"""

    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


class ModelClient(Protocol):
    async def chat(self, messages: list[Message], tools: list[dict[str, Any]],
                   on_text: TextSink | None = None) -> tuple[Message, Usage]: ...


class OpenAICompatModel:
    """OpenAI 兼容接口的流式客户端，只用标准库。

    环境变量：OPENAI_BASE_URL、OPENAI_API_KEY、LLM_MODEL。
    LLM_EXTRA_BODY 是可选的 JSON，会合并进请求体，用来传各家特有的参数，
    例如 DeepSeek 关闭思考：{"thinking": {"type": "disabled"}}。
    """

    def __init__(self, base_url: str | None = None, api_key: str | None = None,
                 model: str | None = None, timeout: float = 120):
        self.base_url = (base_url or os.environ.get("OPENAI_BASE_URL", "https://api.deepseek.com")).rstrip("/")
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self.model = model or os.environ.get("LLM_MODEL", "deepseek-chat")
        self.timeout = timeout
        self.extra_body: dict[str, Any] = json.loads(os.environ.get("LLM_EXTRA_BODY") or "{}")

    async def chat(self, messages, tools, on_text=None, on_tool=None):
        return await asyncio.to_thread(self._chat_sync, messages, tools, on_text, on_tool)

    def _chat_sync(self, messages, tools, on_text, on_tool=None):
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [m.to_api() for m in messages],
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            body["tools"] = tools
        body.update(self.extra_body)
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return parse_stream(resp, on_text, on_tool)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            # 4xx 里只有限流值得重试，其余是请求本身有问题
            raise ModelError(f"模型接口返回 {e.code}：{detail}", retryable=e.code in (408, 429) or e.code >= 500)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise ModelError(f"模型接口连接失败：{e}")


def parse_stream(lines, on_text: TextSink | None, on_tool: ToolSink | None = None) -> tuple[Message, Usage]:
    """把流式响应拼成一条完整消息。

    工具调用的参数是一小段一小段到达的 JSON 片段，必须按调用序号拼完整再解析。
    写一个大文件时参数要生成十几秒：on_tool 把每一段原文交出去，界面可以边生成边显示。
    """
    text: list[str] = []
    reasoning: list[str] = []
    calls: dict[int, dict[str, str]] = {}
    usage = Usage()
    for raw in lines:
        line = raw.decode() if isinstance(raw, bytes) else raw
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        chunk = json.loads(payload)
        if chunk.get("usage"):
            usage = Usage(chunk["usage"].get("prompt_tokens", 0), chunk["usage"].get("completion_tokens", 0))
        for choice in chunk.get("choices") or []:
            delta = choice.get("delta") or {}
            if delta.get("reasoning_content"):
                reasoning.append(delta["reasoning_content"])
            if delta.get("content"):
                text.append(delta["content"])
                if on_text:
                    on_text(delta["content"])
            for tc in delta.get("tool_calls") or []:
                slot = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "args": ""})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                slot["args"] += fn.get("arguments") or ""
                if on_tool and fn.get("arguments") and slot["name"]:
                    on_tool(tc.get("index", 0), slot["name"], fn["arguments"])
    tool_calls = []
    for index in sorted(calls):
        slot = calls[index]
        try:
            args = json.loads(slot["args"] or "{}")
        except json.JSONDecodeError:
            args = {"__raw__": slot["args"]}
        tool_calls.append(ToolCall(id=slot["id"] or f"call_{index}", name=slot["name"], arguments=args))
    return Message(role="assistant", content="".join(text), tool_calls=tool_calls,
                   reasoning="".join(reasoning)), usage


class ScriptedModel:
    """按预先写好的回复依次作答，用于测试和离线回放，不联网。"""

    def __init__(self, replies: list[Message | Exception]):
        self.replies = list(replies)
        self.seen: list[list[Message]] = []

    async def chat(self, messages, tools, on_text=None):
        self.seen.append(list(messages))
        if not self.replies:
            return Message(role="assistant", content="（脚本已用完）"), Usage()
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        if on_text and reply.content:
            on_text(reply.content)
        return reply, Usage(input=10, output=5)
