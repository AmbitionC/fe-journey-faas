"""沙箱执行：命令不在本机跑，而是把工作目录发到一个没有外网、没有密钥的隔离服务里执行。

权限闸门是“做之前拦一下”，沙箱是“即使做了也出不去”。网站上的在线试用用的就是这一套：
模型和内核在一个服务里，模型让执行的每一条命令都在另一个隔离服务里运行。
协议很简单，一次请求带上全部文件和一条命令，返回输出和文件变化，沙箱不保留任何状态。
"""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request

from .tools.coding.workspace import Workspace

MAX_FILE_BYTES = 200_000
MAX_TOTAL_BYTES = 1_500_000


def collect_files(ws: Workspace) -> dict[str, str]:
    files, total = {}, 0
    for p in ws.walk():
        try:
            data = p.read_bytes()
            text = data.decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if len(data) > MAX_FILE_BYTES:
            continue
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise RuntimeError("工作目录太大，无法发送到沙箱执行。")
        files[ws.rel(p)] = text
    return files


def apply_changes(ws: Workspace, changed: dict[str, str], deleted: list[str]) -> None:
    for rel, content in changed.items():
        full = ws.resolve(rel)  # 沙箱返回的路径同样要过路径边界
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
    for rel in deleted:
        full = ws.resolve(rel)
        if full.is_file():
            full.unlink()


class RemoteExecutor:
    def __init__(self, url: str, token: str):
        self.url, self.token = url.rstrip("/"), token

    async def run(self, ws: Workspace, command: str, timeout: int) -> tuple[str, str]:
        payload = {"command": command, "timeout": timeout, "files": collect_files(ws)}

        def post() -> dict:
            req = urllib.request.Request(f"{self.url}/exec", data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json", "X-Sandbox-Token": self.token})
            with urllib.request.urlopen(req, timeout=timeout + 30) as r:
                return json.load(r)

        try:
            result = await asyncio.to_thread(post)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            return "沙箱不可用，命令没有执行", f"{type(e).__name__}: {e}"
        apply_changes(ws, result.get("changed", {}), result.get("deleted", []))
        if result.get("timed_out"):
            return f"超过 {timeout} 秒未结束，已终止，下面是终止前的输出", result.get("output", "")
        return f"退出码 {result.get('exit_code')}", result.get("output", "")
