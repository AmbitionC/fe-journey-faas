"""MCP 客户端（标准输入输出方式）：初始化、列出工具、调用工具，并把工具挂进注册表。

为了让你看清协议在做什么，这里直接按 JSON-RPC 写，不依赖官方 SDK。
远程 HTTP 方式和更完整的能力（资源、提示词、采样）建议换用官方 SDK。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from typing import Any

from ..tools.registry import ToolRegistry
from ..types import Tool

PROTOCOL_VERSION = "2024-11-05"


class McpError(Exception):
    pass


class StdioMcpSession:
    def __init__(self, command: str, args: list[str], env: dict[str, str] | None = None):
        self.command, self.args, self.env = command, args, env
        self.proc: asyncio.subprocess.Process | None = None
        self._id = 0
        self._lock = asyncio.Lock()

    async def start(self, timeout: float = 20) -> dict[str, Any]:
        self.proc = await asyncio.create_subprocess_exec(
            self.command, *self.args, env={**os.environ, **(self.env or {})},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        info = await asyncio.wait_for(self.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
            "clientInfo": {"name": "general-agent", "version": "0.1.0"}}), timeout)
        await self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return info

    async def _send(self, message: dict[str, Any]) -> None:
        self.proc.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode())
        await self.proc.stdin.drain()

    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        async with self._lock:  # 一次只等一个响应，实现最简单
            self._id += 1
            await self._send({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}})
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    raise McpError("MCP 服务已退出")
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("id") != self._id:
                    continue  # 服务端主动发来的通知，忽略
                if "error" in msg:
                    raise McpError(msg["error"].get("message", "未知错误"))
                return msg.get("result", {})

    async def list_tools(self) -> list[dict[str, Any]]:
        return (await self.request("tools/list")).get("tools", [])

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        result = await self.request("tools/call", {"name": name, "arguments": arguments})
        text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        return f"[工具报告了错误]\n{text}" if result.get("isError") else (text or "（没有文字输出）")

    async def close(self) -> None:
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            await self.proc.wait()


def description_digest(tools: list[dict[str, Any]]) -> dict[str, str]:
    """记下每个工具说明的摘要值。下次启动发现变化时提醒用户重新确认。"""
    return {t["name"]: hashlib.sha256((t.get("description") or "").encode()).hexdigest()[:16] for t in tools}


async def mount_mcp_server(name: str, session: StdioMcpSession, registry: ToolRegistry) -> list[dict[str, Any]]:
    listed = await session.list_tools()
    for t in listed:
        async def run(_tool=t["name"], **args: Any) -> str:
            return await session.call_tool(_tool, args)

        registry.register(Tool(
            name=f"mcp__{name}__{t['name']}",  # 加前缀：避免重名，也让权限规则能按服务整体放行或拒绝
            description=t.get("description") or "",
            parameters=t.get("inputSchema") or {"type": "object", "properties": {}},
            run=run,
            read_only=False,  # 别人写的代码，默认当作会改东西，每次调用都过权限闸门
        ))
    return listed


async def mount_all(config: dict[str, Any], registry: ToolRegistry) -> tuple[list[StdioMcpSession], list[str]]:
    """按配置文件挂载全部服务。某个服务连不上只记一条警告，不影响其余功能。"""
    sessions, warnings = [], []
    for name, spec in (config.get("mcpServers") or {}).items():
        if "command" not in spec:
            warnings.append(f"MCP 服务 {name}：本实现只支持标准输入输出方式，已跳过。")
            continue
        session = StdioMcpSession(spec["command"], spec.get("args", []), spec.get("env"))
        try:
            await session.start()
            await mount_mcp_server(name, session, registry)
            sessions.append(session)
        except Exception as e:
            warnings.append(f"MCP 服务 {name} 连接失败：{type(e).__name__}: {e}")
            await session.close()
    return sessions, warnings
