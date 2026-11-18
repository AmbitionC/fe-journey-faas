"""在线试用的入口服务：收到一个任务，在示例仓库的全新副本上运行 Agent，把过程用 SSE 推给浏览器。

这个服务里不执行任何由模型或用户决定的代码：文件工具只做读写，命令全部交给隔离的沙箱服务。
所以模型密钥放在这里是安全的，沙箱里看不到它。

防滥用：
- 必须带网站后端签发的一次性票据（HMAC 签名、两分钟内有效），后端在签发前检查登录和每日次数。
- 每次运行有轮次、总时长、输出量上限。
- 无界面模式：只放行运行测试的命令，其余命令一律拒绝。
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import queue
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from agent.build import build_coding_agent  # noqa: E402
from agent.kernel.permission import Rule  # noqa: E402
from agent.model import OpenAICompatModel  # noqa: E402
from agent.sandbox import RemoteExecutor  # noqa: E402
from agent.types import Event  # noqa: E402

PORT = int(os.environ.get("FC_SERVER_PORT") or os.environ.get("PORT") or 9000)
TICKET_SECRET = os.environ.get("TRIAL_TICKET_SECRET", "")
SANDBOX_URL = os.environ.get("SANDBOX_URL", "")
SANDBOX_TOKEN = os.environ.get("SANDBOX_TOKEN", "")
ALLOWED_ORIGINS = [o for o in os.environ.get("TRIAL_ALLOWED_ORIGINS", "").split(",") if o]
MAX_TURNS = int(os.environ.get("TRIAL_MAX_TURNS", "14"))
MAX_SECONDS = int(os.environ.get("TRIAL_MAX_SECONDS", "150"))
MAX_TASK_CHARS = 300

SCENARIOS = {
    "shop": {
        "title": "修好购物车的金额计算",
        "repo": ROOT / "fixtures" / "shop",
        "default_task": "tests/test_cart.py 里有用例挂了，帮我找到原因并修好。不要修改测试。",
    },
}
ALLOW = ["python -m pytest*", "pytest*", "python3 -m pytest*", "ls*", "cat *", "git status*", "git diff*"]

_used: dict[str, float] = {}  # 票据编号 -> 过期时间，防止同一张票据重复使用
_used_lock = threading.Lock()


def sign(payload: dict, secret: str) -> str:
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{mac}"


def verify(ticket: str, secret: str, now: float | None = None) -> dict | None:
    """返回票据内容，无效时返回 None。"""
    if not secret or "." not in ticket:
        return None
    body, mac = ticket.rsplit(".", 1)
    good = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, good):
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except Exception:
        return None
    now = now or time.time()
    if not isinstance(payload, dict) or payload.get("exp", 0) < now or not payload.get("jti"):
        return None
    with _used_lock:
        for jti in [j for j, exp in _used.items() if exp < now]:
            del _used[jti]
        if payload["jti"] in _used:
            return None
        _used[payload["jti"]] = payload["exp"]
    return payload


def public_event(event: Event) -> dict | None:
    """发给浏览器的事件。工具结果只发前一段，避免把整个文件内容推到页面上。"""
    d = event.data
    if event.kind == "text_delta":
        return {"type": "text", "text": d["text"]}
    if event.kind == "tool_start":
        return {"type": "tool_start", "id": d["id"], "name": d["name"], "arguments": d["arguments"]}
    if event.kind == "tool_end":
        return {"type": "tool_end", "id": d["id"], "name": d["name"], "denied": d["denied"],
                "result": d["result"][:3000]}
    return None


async def run_trial(scenario: dict, task: str, emit) -> dict:
    tmp = Path(tempfile.mkdtemp(prefix="trial-"))
    workdir = tmp / "repo"
    shutil.copytree(scenario["repo"], workdir, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    before = {str(p.relative_to(workdir)): p.read_text(encoding="utf-8") for p in workdir.rglob("*.py")}
    try:
        agent = build_coding_agent(
            OpenAICompatModel(), workdir, headless=True, home=tmp, subagents=False,
            rules=[Rule("run_command", p, "allow") for p in ALLOW]
            + [Rule(t, "*", "allow") for t in ("write_file", "edit_file")],
            executor=RemoteExecutor(SANDBOX_URL, SANDBOX_TOKEN), command_timeout=45,
            max_turns=MAX_TURNS, on_event=lambda e: (ev := public_event(e)) and emit(ev))
        try:
            outcome = await asyncio.wait_for(agent.run(task), timeout=MAX_SECONDS)
            summary = {"stopped": outcome.stopped, "turns": outcome.turns,
                       "input_tokens": outcome.usage.input, "output_tokens": outcome.usage.output}
        except asyncio.TimeoutError:
            summary = {"stopped": "timeout", "turns": 0, "input_tokens": 0, "output_tokens": 0}
        after = {str(p.relative_to(workdir)): p.read_text(encoding="utf-8") for p in workdir.rglob("*.py")}
        summary["changed_files"] = [{"path": k, "before": before.get(k, ""), "after": v}
                                    for k, v in sorted(after.items()) if before.get(k) != v][:10]
        return summary
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        self._json(200, {"ok": True, "configured": bool(TICKET_SECRET and SANDBOX_URL and SANDBOX_TOKEN),
                         "scenarios": {k: {"title": v["title"], "default_task": v["default_task"]}
                                       for k, v in SCENARIOS.items()}})

    def do_POST(self) -> None:
        if self.path.split("?")[0].rstrip("/") != "/run":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length)) if 0 < length < 20_000 else {}
        except Exception:
            req = {}
        ticket = verify(str(req.get("ticket", "")), TICKET_SECRET)
        if ticket is None:
            return self._json(401, {"error": "试用票据无效或已过期，请刷新页面重试。"})
        scenario = SCENARIOS.get(str(req.get("scenario") or ticket.get("scenario") or "shop"))
        if scenario is None:
            return self._json(400, {"error": "没有这个试用场景。"})
        task = str(req.get("task") or "").strip()[:MAX_TASK_CHARS] or scenario["default_task"]

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        events: queue.Queue = queue.Queue()

        def worker() -> None:
            try:
                events.put({"type": "done", **asyncio.run(run_trial(scenario, task, events.put))})
            except Exception as e:
                events.put({"type": "error", "message": f"{type(e).__name__}: {e}"})
            events.put(None)

        threading.Thread(target=worker, daemon=True).start()
        try:
            self._send({"type": "start", "task": task, "max_turns": MAX_TURNS})
            while True:
                try:
                    ev = events.get(timeout=10)
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                    continue
                if ev is None:
                    break
                self._send(ev)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器关了页面

    def _send(self, ev: dict) -> None:
        self.wfile.write(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode())
        self.wfile.flush()

    def log_message(self, *args) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
