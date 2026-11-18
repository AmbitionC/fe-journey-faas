"""模型调用：OpenAI 兼容客户端、限流的调用池、按环节记账和运行预算。只用标准库。

环节不直接拿客户端，而是拿 Models.stage("review") 这样的句柄：
它决定这个环节用哪个模型、走哪个调用池，并把每次调用的用量和耗时记到账上。
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable


class RateLimitError(Exception):
    def __init__(self, message: str = "", retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class TransientError(Exception):
    """超时、5xx、连接中断：等一会儿重试有意义。"""


class GiveUp(Exception):
    """重试用完仍然失败。"""


class BudgetExceeded(Exception):
    """运行预算用完。活动会保存状态后停下。"""


class ChatModel:
    """OpenAI 兼容接口的非流式客户端。

    环境变量：OPENAI_BASE_URL、OPENAI_API_KEY、LLM_MODEL；
    LLM_EXTRA_BODY 是可选的 JSON，合并进请求体（例如 DeepSeek 关闭思考）。
    """

    def __init__(self, model: str | None = None, base_url: str | None = None, api_key: str | None = None,
                 timeout: float = 90):
        self.base_url = (base_url or os.environ.get("OPENAI_BASE_URL", "https://api.deepseek.com")).rstrip("/")
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self.model = model or os.environ.get("LLM_MODEL", "deepseek-chat")
        self.timeout = timeout
        self.extra_body: dict[str, Any] = json.loads(os.environ.get("LLM_EXTRA_BODY") or "{}")
        self.last_usage = (0, 0)

    async def ask(self, system: str, user: str, *, data: dict | None = None) -> str:
        text, self.last_usage = await asyncio.to_thread(self._ask_sync, system, user)
        return text

    def _ask_sync(self, system: str, user: str) -> tuple[str, tuple[int, int]]:
        body = {"model": self.model, "messages": [{"role": "system", "content": system},
                                                  {"role": "user", "content": user}], **self.extra_body}
        req = urllib.request.Request(f"{self.base_url}/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json",
                                              "Authorization": f"Bearer {self.api_key}"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                out = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                after = e.headers.get("Retry-After")
                raise RateLimitError("429", float(after) if after and after.replace(".", "").isdigit() else None)
            if e.code >= 500:
                raise TransientError(f"HTTP {e.code}")
            raise RuntimeError(f"模型接口返回 {e.code}：{e.read()[:200].decode(errors='replace')}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise TransientError(str(e))
        usage = out.get("usage") or {}
        return (out["choices"][0]["message"].get("content") or "",
                (usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)))


class ScriptedModel:
    """测试用：按顺序吐出预先写好的回复，或者交给一个函数决定。"""

    def __init__(self, replies: list[str] | Callable[[str, str, dict | None], str]):
        self.replies, self.calls = replies, []
        self.model = "scripted"
        self.last_usage = (0, 0)

    async def ask(self, system: str, user: str, *, data: dict | None = None) -> str:
        self.calls.append((system, user, data))
        if callable(self.replies):
            return self.replies(system, user, data)
        return self.replies.pop(0)


class TokenBucket:
    def __init__(self, rate: float, capacity: float):
        self.rate, self.capacity = rate, max(capacity, 1.0)
        self.tokens, self.at = self.capacity, time.monotonic()
        self.lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self.lock:
            while True:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.at) * self.rate)
                self.at = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                await asyncio.sleep((1 - self.tokens) / self.rate)


class RateLimitedPool:
    """并发数和速率是两个限制：信号量管同时在途的请求数，令牌桶管单位时间的请求数。"""

    def __init__(self, max_concurrency: int = 8, rpm: int = 600, sleep=asyncio.sleep):
        self.sem = asyncio.Semaphore(max_concurrency)
        self.bucket = TokenBucket(rate=rpm / 60, capacity=rpm // 6)
        self.retried, self.sleep = 0, sleep

    async def call(self, fn, *args, retries: int = 4, **kwargs):
        last: Exception | None = None
        for attempt in range(retries):
            await self.bucket.acquire()
            async with self.sem:
                try:
                    return await fn(*args, **kwargs)
                except RateLimitError as e:
                    last, wait = e, e.retry_after or 2 ** attempt + random.random()
                except TransientError as e:
                    last, wait = e, 2 ** attempt + random.random()   # 退避带随机量，避免一批请求同时重试
            self.retried += 1
            await self.sleep(wait)
        raise GiveUp(f"重试 {retries} 次后仍失败：{last}")


@dataclass
class Call:
    stage: str
    model: str
    input_tokens: int
    output_tokens: int
    ms: int


class Ledger:
    """按环节记账。运行预算是硬闸：每次调用前检查，超出就抛 BudgetExceeded。"""

    def __init__(self, max_calls: int | None = None, max_tokens: int | None = None, sink=None):
        self.calls: list[Call] = []
        self.max_calls, self.max_tokens, self.sink = max_calls, max_tokens, sink
        self.cache_hits: dict[str, int] = {}

    @property
    def tokens(self) -> int:
        return sum(c.input_tokens + c.output_tokens for c in self.calls)

    def check(self) -> None:
        if self.max_calls is not None and len(self.calls) >= self.max_calls:
            raise BudgetExceeded(f"模型调用次数达到运行预算上限 {self.max_calls}")
        if self.max_tokens is not None and self.tokens >= self.max_tokens:
            raise BudgetExceeded(f"模型用量达到运行预算上限 {self.max_tokens}")

    def record(self, call: Call) -> None:
        self.calls.append(call)
        if self.sink:
            self.sink(call)

    def hit(self, stage: str) -> None:
        self.cache_hits[stage] = self.cache_hits.get(stage, 0) + 1

    def by_stage(self) -> list[dict]:
        rows: dict[str, dict] = {}
        for c in self.calls:
            r = rows.setdefault(c.stage, {"stage": c.stage, "calls": 0, "input_tokens": 0, "output_tokens": 0, "ms": 0})
            r["calls"] += 1
            r["input_tokens"] += c.input_tokens
            r["output_tokens"] += c.output_tokens
            r["ms"] += c.ms
        for stage, n in self.cache_hits.items():
            rows.setdefault(stage, {"stage": stage, "calls": 0, "input_tokens": 0, "output_tokens": 0, "ms": 0})
            rows[stage]["cache_hits"] = n
        return sorted(rows.values(), key=lambda r: -r["calls"])


class StageModel:
    def __init__(self, stage: str, inner, pool: RateLimitedPool, ledger: Ledger, on_call=None):
        self.stage, self.inner, self.pool, self.ledger, self.on_call = stage, inner, pool, ledger, on_call

    async def ask(self, system: str, user: str, *, data: dict | None = None) -> str:
        self.ledger.check()
        t0 = time.monotonic()
        reply = await self.pool.call(self.inner.ask, system, user, data=data)
        usage = getattr(self.inner, "last_usage", (0, 0))
        self.ledger.record(Call(self.stage, getattr(self.inner, "model", "?"), usage[0], usage[1],
                                int((time.monotonic() - t0) * 1000)))
        if self.on_call:
            self.on_call(self.stage, system, user, reply)
        return reply


# 环节到能力档位：推理强的、写文案的、量大而简单的。见 README「分级用模型」
TIERS = {"lead": "strong", "attribute": "strong", "evolve": "strong", "segment": "strong", "product": "strong",
         "creative": "writer", "selfcheck": "cheap", "review": "cheap", "sim": "cheap"}
# 量大的环节各用各的池，免得上千次模拟打分把审核的配额挤掉
POOLS = {"sim": "sim", "review": "review"}


class Models:
    """给每个环节发模型句柄。

    tiers 把档位映射到模型，例如 {"strong": 强模型, "writer": 中等模型, "cheap": 便宜模型, "sim": 另一家的模型}。
    没单独配置的档位退回 default。给 "sim" 单独配一个不同厂商的模型，可以缓解“自己出题自己判卷”。
    """

    def __init__(self, default, tiers: dict | None = None, ledger: Ledger | None = None,
                 max_concurrency: int = 8, rpm: int = 600, on_call=None):
        self.default, self.tiers = default, tiers or {}
        self.ledger = ledger or Ledger()
        self.on_call = on_call
        self.pools = {name: RateLimitedPool(max_concurrency, rpm) for name in ("default", "sim", "review")}

    def stage(self, stage: str) -> StageModel:
        inner = self.tiers.get(stage) or self.tiers.get(TIERS.get(stage, ""), self.default)
        return StageModel(stage, inner, self.pools[POOLS.get(stage, "default")], self.ledger, self.on_call)


def extract_json(text: str):
    """从模型回复里取出第一段 JSON（对象或数组）。取不到返回 None。"""
    text = re.sub(r"```(?:json)?", "", text)
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        return None
    start = min(starts)
    close = "}" if text[start] == "{" else "]"
    end = text.rfind(close)
    while end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            end = text.rfind(close, start, end)
    return None
