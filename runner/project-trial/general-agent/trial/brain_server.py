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
from agent.types import Event, Message  # noqa: E402

PORT = int(os.environ.get("FC_SERVER_PORT") or os.environ.get("PORT") or 9000)
TICKET_SECRET = os.environ.get("TRIAL_TICKET_SECRET", "")
SANDBOX_URL = os.environ.get("SANDBOX_URL", "")
SANDBOX_TOKEN = os.environ.get("SANDBOX_TOKEN", "")
ALLOWED_ORIGINS = [o for o in os.environ.get("TRIAL_ALLOWED_ORIGINS", "").split(",") if o]
MAX_TURNS = int(os.environ.get("TRIAL_MAX_TURNS", "24"))
MAX_SECONDS = int(os.environ.get("TRIAL_MAX_SECONDS", "150"))
MAX_TASK_CHARS = 500
# 同一个会话里接着下任务：浏览器把上一轮结束时的工作区改动和最近几句对话带回来
MAX_HISTORY_MESSAGES = 6
MAX_HISTORY_CHARS = 1500
MAX_CARRIED_FILES = 40
MAX_CARRIED_BYTES = 120_000
SKIP_DIRS = ("__pycache__", ".pytest_cache")

SCENARIOS = {
    "store": {
        "title": "在一个小型电商后端里干活",
        "repo": ROOT / "fixtures" / "store",
        "default_task": "跑一下测试，有几条用例挂了。找到原因并修好，不要修改测试。",
    },
    "shop": {
        "title": "修好购物车的金额计算",
        "repo": ROOT / "fixtures" / "shop",
        "default_task": "tests/test_cart.py 里有用例挂了，帮我找到原因并修好。不要修改测试。",
    },
}
# 命令都在隔离沙箱里执行，放行面可以宽一些；没列出的（比如 curl、pip）仍会被权限闸门拦下
ALLOW = ["python*", "pytest*", "ls*", "cat *", "head*", "tail*", "grep*", "find*", "wc*", "echo*", "rm *",
         "git status*", "git diff*"]
# 附在任务后面、不显示给用户：试用有轮次上限，让它做完就收尾
TASK_SUFFIX = ("\n\n（这是网页上的试用，轮次有限：做完就停下来，用几句话说明结论和改了什么。不要新建临时文件。"
               "如果任务是做一个网页，就写成单个 HTML 文件，样式和脚本都内联、不引用外部资源，一次写完整；"
               "页面会直接显示在用户旁边的预览里，不需要你验证，也不要顺手改仓库里别的文件。"
               "收尾时用两三句话说做了什么、怎么用，不用交代没做哪些验证。）")
# 只有写文件、改文件的参数值得边生成边推给页面；每攒够这么多字符推一次
STREAMED_TOOLS = ("write_file", "edit_file")
DELTA_FLUSH_CHARS = 240


def read_tree(root: Path) -> dict[str, str]:
    """工作区里全部文本文件的内容，用来比较一次运行前后的变化。"""
    out = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.is_symlink() or set(SKIP_DIRS) & set(p.parts):
            continue
        try:
            out[p.relative_to(root).as_posix()] = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
    return out


def safe_rel(path: str) -> bool:
    parts = Path(path).parts
    return (bool(parts) and not Path(path).is_absolute() and ".." not in parts and len(path) < 200
            and not set(SKIP_DIRS) & set(parts) and not parts[0].startswith("."))


def clean_workspace(raw) -> tuple[dict[str, str], list[str]]:
    """校验浏览器带回来的工作区改动：只收相对路径的文本，数量和体积都有上限，超了就整个不要。"""
    if not isinstance(raw, dict):
        return {}, []
    files = raw.get("files") if isinstance(raw.get("files"), dict) else {}
    deleted = raw.get("deleted") if isinstance(raw.get("deleted"), list) else []
    ok = {k: v for k, v in files.items() if isinstance(k, str) and isinstance(v, str) and safe_rel(k)}
    gone = [k for k in deleted if isinstance(k, str) and safe_rel(k)]
    if (len(ok) != len(files) or len(gone) != len(deleted) or len(ok) + len(gone) > MAX_CARRIED_FILES
            or sum(len(v.encode()) for v in ok.values()) > MAX_CARRIED_BYTES):
        return {}, []
    return ok, gone


def clean_history(raw) -> list[tuple[str, str]]:
    """最近几句对话，只认用户和助手两种角色，每句截断。用来让它知道“刚才那个”指什么。"""
    if not isinstance(raw, list):
        return []
    out = []
    for m in raw[-MAX_HISTORY_MESSAGES:]:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            text = m["content"].strip()[:MAX_HISTORY_CHARS]
            if text:
                out.append((m["role"], text))
    return out


def apply_workspace(workdir: Path, files: dict[str, str], deleted: list[str]) -> None:
    for rel in deleted:
        target = workdir / rel
        if target.is_file():
            target.unlink()
    for rel, content in files.items():
        target = workdir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def load_plugins() -> None:
    """同一个入口可以挂别的项目的试用场景：旁边的项目目录里有 trial/plugin.py 就加载，
    由它的 register(SCENARIOS) 登记场景（带一个 run(task, emit) 协程）。加载失败只影响那个项目。"""
    import importlib.util
    for path in sorted(ROOT.parent.glob("*/trial/plugin.py")):
        try:
            spec = importlib.util.spec_from_file_location(f"trial_plugin_{path.parent.parent.name}", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            mod.register(SCENARIOS)
        except Exception as e:
            print(f"试用场景加载失败 {path}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)


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
    if event.kind == "tool_delta":
        if d["name"] not in STREAMED_TOOLS:
            return None
        return {"type": "tool_delta", "index": d["index"], "name": d["name"], "delta": d["delta"]}
    if event.kind == "tool_end":
        out = {"type": "tool_end", "id": d["id"], "name": d["name"], "denied": d["denied"],
               "result": d["result"][:3000]}
        if d["denied"]:
            out["arguments"] = d.get("arguments", {})  # 被权限闸门拦下的调用没有 tool_start
        return out
    return None


async def run_trial(scenario: dict, task: str, emit, workspace=None, history=None) -> dict:
    tmp = Path(tempfile.mkdtemp(prefix="trial-"))
    workdir = tmp / "repo"
    shutil.copytree(scenario["repo"], workdir, ignore=shutil.ignore_patterns(*SKIP_DIRS))
    pristine = read_tree(workdir)
    apply_workspace(workdir, *clean_workspace(workspace))
    before = read_tree(workdir)
    pending: dict[tuple[int, str], str] = {}

    def flush() -> None:
        for (index, name), text in list(pending.items()):
            emit({"type": "tool_delta", "index": index, "name": name, "delta": text})
        pending.clear()

    def forward(event: Event) -> None:
        """参数片段一个词一段，攒一攒再推；别的事件到来前先把攒着的推完，顺序才对。"""
        ev = public_event(event)
        if ev is None:
            return
        if ev["type"] == "tool_delta":
            key = (ev["index"], ev["name"])
            pending[key] = pending.get(key, "") + ev["delta"]
            if len(pending[key]) >= DELTA_FLUSH_CHARS:
                flush()
            return
        flush()
        emit(ev)

    try:
        agent = build_coding_agent(
            OpenAICompatModel(), workdir, headless=True, home=tmp, subagents=False,
            rules=[Rule("run_command", p, "allow") for p in ALLOW]
            + [Rule(t, "*", "allow") for t in ("write_file", "edit_file")],
            executor=RemoteExecutor(SANDBOX_URL, SANDBOX_TOKEN), command_timeout=45,
            max_turns=MAX_TURNS, on_event=forward)
        # 之前几句对话接在系统提示词后面。上一轮的工具调用细节不带，文件的现状已经在工作区里了
        for role, text in clean_history(history):
            agent.messages.append(Message(role, text))
        try:
            outcome = await asyncio.wait_for(agent.run(task + TASK_SUFFIX), timeout=MAX_SECONDS)
            summary = {"stopped": outcome.stopped, "turns": outcome.turns,
                       "input_tokens": outcome.usage.input, "output_tokens": outcome.usage.output}
        except asyncio.TimeoutError:
            summary = {"stopped": "timeout", "turns": 0, "input_tokens": 0, "output_tokens": 0}
        after = read_tree(workdir)
        # 这一轮改了什么（给页面显示改动），以及相对初始仓库的全部改动（下一轮带回来）
        summary["changed_files"] = [{"path": k, "before": before.get(k, ""), "after": after.get(k, "")}
                                    for k in sorted(set(before) | set(after)) if before.get(k) != after.get(k)][:20]
        summary["workspace"] = {"files": {k: v for k, v in after.items() if pristine.get(k) != v},
                                "deleted": [k for k in pristine if k not in after]}
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
            req = json.loads(self.rfile.read(length)) if 0 < length < 400_000 else {}
        except Exception:
            req = {}
        ticket = verify(str(req.get("ticket", "")), TICKET_SECRET)
        if ticket is None:
            return self._json(401, {"error": "试用票据无效或已过期，请刷新页面重试。"})
        # 场景以票据为准：次数是按票据发的，请求里另写一个场景不算数
        name = str(ticket.get("scenario") or "store")
        if req.get("scenario") and str(req["scenario"]) != name:
            return self._json(403, {"error": "试用票据和要运行的场景对不上，请刷新页面重试。"})
        scenario = SCENARIOS.get(name)
        if scenario is None:
            return self._json(400, {"error": "没有这个试用场景。"})
        task = str(req.get("task") or "").strip()[:MAX_TASK_CHARS] or scenario["default_task"]
        if scenario.get("fixed_task"):
            task = scenario["default_task"]
        runner = scenario["run"] if "run" in scenario else (
            lambda task, emit: run_trial(scenario, task, emit, req.get("workspace"), req.get("history")))

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        # 必须分块传输：只写 Connection: close 的话，函数计算的网关会等连接关闭才把整段响应交给浏览器
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        events: queue.Queue = queue.Queue()

        def worker() -> None:
            try:
                events.put({"type": "done", **asyncio.run(runner(task, events.put))})
            except Exception as e:
                events.put({"type": "error", "message": f"{type(e).__name__}: {e}"})
            events.put(None)

        threading.Thread(target=worker, daemon=True).start()
        try:
            self._send({"type": "start", "task": task, "max_turns": scenario.get("max_turns", MAX_TURNS)})
            while True:
                try:
                    ev = events.get(timeout=10)
                except queue.Empty:
                    self._chunk(b": keep-alive\n\n")
                    continue
                if ev is None:
                    break
                self._send(ev)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器关了页面

    def _send(self, ev: dict) -> None:
        self._chunk(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode())

    def _chunk(self, data: bytes) -> None:
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def log_message(self, *args) -> None:
        pass


load_plugins()

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
