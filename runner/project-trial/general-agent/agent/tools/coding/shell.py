"""执行命令：超时、输出截断、固定工作目录、不提供交互。"""
from __future__ import annotations

import asyncio
import os
import signal
from typing import Protocol

from ...types import Tool
from ..registry import tool, truncate
from .workspace import Workspace


class Executor(Protocol):
    """命令在哪里执行。默认在本机；换成沙箱只需要换这一个对象，工具和内核都不用改。"""

    async def run(self, ws: Workspace, command: str, timeout: int) -> tuple[str, str]: ...  # (状态, 输出)


def shell_tool(ws: Workspace, default_timeout: int = 120, executor: "Executor | None" = None) -> Tool:
    executor = executor or LocalExecutor()

    @tool()
    async def run_command(command: str, timeout: int = default_timeout) -> str:
        """在项目目录里执行一条 shell 命令，返回退出码和输出。

        用来运行测试、查看 git 状态、安装依赖等。命令不能等待键盘输入，
        需要确认的命令请加上免交互参数（如 -y）。读写文件请用专门的文件工具。

        Args:
            command: 要执行的命令
            timeout: 超时秒数
        """
        status, text = await executor.run(ws, command, timeout)
        text = text.strip()
        return f"[{status}]\n{truncate(text, 8000) if text else '（没有输出）'}"

    return run_command


class LocalExecutor:
    async def run(self, ws: Workspace, command: str, timeout: int) -> tuple[str, str]:
        proc = await asyncio.create_subprocess_shell(
            command, cwd=ws.root, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,  # 独立进程组，超时时整组杀掉
        )
        chunks: list[bytes] = []

        async def pump() -> None:
            assert proc.stdout is not None
            while data := await proc.stdout.read(4096):
                chunks.append(data)

        reader = asyncio.create_task(pump())
        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout)
            await reader
            status = f"退出码 {proc.returncode}"
        except asyncio.TimeoutError:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            reader.cancel()
            status = f"超过 {timeout} 秒未结束，已终止，下面是终止前的输出"
        out = b"".join(chunks)
        return status, out.decode(errors="replace")
