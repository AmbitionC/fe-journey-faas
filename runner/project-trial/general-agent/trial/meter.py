"""在线试用的用量计量：一次运行里所有模型调用的 token 都记在这里，超时、出错、断开的也算。

各项目自己的汇总只有正常跑完才可靠：超时的一次运行里，已经完成的和正在生成的调用都花了钱。
所以在模型客户端最底层（真正发请求的那个函数）外面包一层，谁调用都记得到。
用 ContextVar 区分同时进行的几次运行：asyncio 的任务和 to_thread 的线程都会继承它。
"""
from __future__ import annotations

import contextlib
import functools
import sys
import threading
from contextvars import ContextVar

CHARS_PER_TOKEN = 2      # 被掐断的调用拿不到接口返回的用量，按字数估


class RunStopped(Exception):
    """这次运行已经结束（超时、页面关了），正在生成的调用就地停下。"""


class Meter:
    def __init__(self) -> None:
        self.input_tokens = self.output_tokens = self.calls = self.estimated_calls = 0
        self.stopped = False
        self._lock = threading.Lock()

    def add(self, input_tokens: int, output_tokens: int, estimated: bool = False) -> None:
        with self._lock:
            self.calls += 1
            self.estimated_calls += estimated
            self.input_tokens += int(input_tokens)
            self.output_tokens += int(output_tokens)

    def stop(self) -> None:
        self.stopped = True

    def check(self) -> None:
        if self.stopped:
            raise RunStopped("这次运行已经结束")


_current: ContextVar[Meter | None] = ContextVar("trial_meter", default=None)


@contextlib.contextmanager
def measure():
    m = Meter()
    token = _current.set(m)
    try:
        yield m
    finally:
        _current.reset(token)


def _estimate(chars: int) -> int:
    return chars // CHARS_PER_TOKEN


def metered_stream(fn):
    """包住 OpenAICompatModel._chat_sync（流式）。每收到一段就看一眼要不要停，停了连接随之关闭，后面的不再花钱。"""
    @functools.wraps(fn)
    def wrapped(self, messages, tools, on_text, on_tool=None):
        m = _current.get()
        if m is None:
            return fn(self, messages, tools, on_text, on_tool)
        m.check()
        got = 0

        def text(piece):
            nonlocal got
            got += len(piece)
            m.check()
            if on_text:
                on_text(piece)

        def tool(index, name, piece):
            nonlocal got
            got += len(piece)
            m.check()
            if on_tool:
                on_tool(index, name, piece)

        def estimate():
            sent = sum(len(str(x.to_api())) for x in messages) + len(str(tools or ""))
            m.add(_estimate(sent), _estimate(got), estimated=True)

        try:
            reply, usage = fn(self, messages, tools, text, tool)
        except BaseException:
            if got:             # 已经开始生成才断的：钱花了，接口没来得及给用量
                estimate()
            raise
        if usage.input or usage.output:
            m.add(usage.input, usage.output)
        else:
            estimate()
        return reply, usage
    return wrapped


def metered_ask(fn):
    """包住 growth.llm.ChatModel._ask_sync（非流式）。发出去就停不下来，只能等它回来照实记。"""
    @functools.wraps(fn)
    def wrapped(self, system, user):
        m = _current.get()
        if m is None:
            return fn(self, system, user)
        m.check()
        text, usage = fn(self, system, user)
        m.add(*usage) if any(usage) else m.add(_estimate(len(system) + len(user)), _estimate(len(text)), estimated=True)
        return text, usage
    return wrapped


def install() -> None:
    """给已经加载的模型客户端装上计量。插件都加载完之后调用一次。"""
    for module, cls, method, wrap in (("agent.model", "OpenAICompatModel", "_chat_sync", metered_stream),
                                      ("growth.llm", "ChatModel", "_ask_sync", metered_ask)):
        client = getattr(sys.modules.get(module), cls, None)
        if client is not None and not hasattr(getattr(client, method), "__wrapped__"):
            setattr(client, method, wrap(getattr(client, method)))
