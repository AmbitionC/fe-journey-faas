"""本地网页工作台：在浏览器里给 Agent 下任务，看它读代码、跑命令、改文件。

    python -m agent.web                      # 用自带的示例仓库 fixtures/store
    python -m agent.web --repo ../my-project  # 换成你自己的项目

终端（agent/cli.py）、网站上的在线试用（trial/）和这里是三个外壳，装的是同一个内核：
都从 agent.build.build_coding_agent 拿 Agent，区别只在事件怎么显示、权限怎么确认、命令在哪执行。

和在线试用不同的两点：
- 命令直接在你的电脑上执行，没有沙箱。所以这里默认只放行跑测试和只读的命令，其余一律被权限闸门拦下。
- Agent 不直接改你给的目录，而是先复制一份工作副本，在副本上干活。「重置」就是重新复制一份。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import queue
import shutil
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

from ..build import build_coding_agent
from ..kernel.permission import Rule
from ..model import ModelClient, OpenAICompatModel
from ..types import Event, Message

ROOT = Path(__file__).resolve().parents[2]
STATIC = Path(__file__).resolve().parent / "static"
SKIP_DIRS = ("__pycache__", ".pytest_cache", ".git", ".venv", "node_modules", ".agent")
MAX_FILE_BYTES = 200_000
# 没有沙箱，放行面要窄：跑测试、看文件。没列出的命令在无界面模式下直接拒绝，页面上能看到被拦下的那一步
ALLOW = ["python -m pytest*", "pytest*", "ls*", "cat *", "head *", "tail *", "grep *", "find *", "wc *",
         "git status*", "git diff*"]
SAMPLES = [
    {"title": "修好挂掉的测试", "task": "跑一下测试，有几条用例挂了。找到原因并修好，不要修改测试。"},
    {"title": "排查库存超卖", "task": "有用户反馈同一件商品被卖超了。检查 store/inventory.py 的预占逻辑，有问题就修掉，并补一条能复现这个问题的测试。"},
    {"title": "加一个运费功能", "task": "给订单加上运费：实付金额满 99 元免运费，否则收 8 元。在 Order 上加 shipping_cents 字段，并补上测试。"},
    {"title": "讲清下单流程", "task": "下一张订单会依次经过哪些函数？按调用顺序讲一遍，指出每一步在哪个文件。不要改代码。"},
]


def read_tree(root: Path) -> dict[str, str]:
    """工作副本里全部文本文件的内容，用来显示文件树和比较改动。"""
    out = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.is_symlink() or set(SKIP_DIRS) & set(p.relative_to(root).parts):
            continue
        try:
            if p.stat().st_size <= MAX_FILE_BYTES:
                out[p.relative_to(root).as_posix()] = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
    return out


def public_event(event: Event) -> dict | None:
    """内核事件转成页面事件。和在线试用用同一套格式，页面代码可以互换。"""
    d = event.data
    if event.kind == "text_delta":
        return {"type": "text", "text": d["text"]}
    if event.kind == "tool_start":
        return {"type": "tool_start", "id": d["id"], "name": d["name"], "arguments": d["arguments"]}
    if event.kind == "tool_end":
        out = {"type": "tool_end", "id": d["id"], "name": d["name"], "denied": d["denied"],
               "result": d["result"][:6000]}
        if d["denied"]:
            out["arguments"] = d.get("arguments", {})  # 被权限闸门拦下的调用没有 tool_start
        return out
    return None


class Workbench:
    """一个工作副本加一段对话。同一时间只跑一个任务。"""

    def __init__(self, repo: Path, model_factory: Callable[[], ModelClient], max_turns: int = 40):
        self.repo = repo.resolve()
        self.model_factory = model_factory
        self.max_turns = max_turns
        self.busy = threading.Lock()
        self.tmp = Path(tempfile.mkdtemp(prefix="agent-web-"))
        self.workdir = self.tmp / self.repo.name
        self.history: list[tuple[str, str]] = []
        self.agent = None  # 正在运行的那个 Agent，停止按钮用
        self.reset()

    def reset(self) -> None:
        shutil.rmtree(self.workdir, ignore_errors=True)
        shutil.copytree(self.repo, self.workdir, ignore=shutil.ignore_patterns(*SKIP_DIRS))
        self.pristine = read_tree(self.workdir)
        self.history = []

    def state(self) -> dict:
        return {"repo": self.repo.name, "source": str(self.repo), "workdir": str(self.workdir),
                "files": read_tree(self.workdir), "pristine": self.pristine,
                "samples": SAMPLES if self.repo.name == "store" else []}

    async def run(self, task: str, emit: Callable[[dict], None]) -> dict:
        before = read_tree(self.workdir)
        agent = build_coding_agent(
            self.model_factory(), self.workdir, headless=True, home=self.tmp, subagents=False,
            rules=[Rule("run_command", p, "allow") for p in ALLOW]
            + [Rule(t, "*", "allow") for t in ("write_file", "edit_file")],
            max_turns=self.max_turns, on_event=lambda e: (ev := public_event(e)) and emit(ev))
        # 之前几句对话接在系统提示词后面，它才知道“刚才那个”指什么。文件的现状已经在工作副本里了
        for role, text in self.history[-6:]:
            agent.messages.append(Message(role, text[:1500]))
        self.agent = agent
        try:
            outcome = await agent.run(task)
        finally:
            self.agent = None
        after = read_tree(self.workdir)
        self.history += [("user", task), ("assistant", outcome.text)]
        return {"stopped": outcome.stopped, "turns": outcome.turns,
                "input_tokens": outcome.usage.input, "output_tokens": outcome.usage.output,
                "changed_files": [{"path": k, "before": before.get(k, ""), "after": after.get(k, "")}
                                  for k in sorted(set(before) | set(after)) if before.get(k) != after.get(k)],
                "files": after}

    def close(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


def make_handler(bench: Workbench):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, code: int, data: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _json(self, code: int, body: dict) -> None:
            self._send(code, json.dumps(body, ensure_ascii=False).encode(), "application/json; charset=utf-8")

        def _local(self) -> bool:
            """只接受本机页面发来的请求：别的网站不能借你的浏览器让它在你电脑上跑任务。"""
            origin = self.headers.get("Origin", "")
            host = self.headers.get("Host", "")
            ok_host = host.split(":")[0] in ("127.0.0.1", "localhost")
            return ok_host and (not origin or origin in (f"http://{host}",))

        def do_GET(self) -> None:
            path = self.path.split("?")[0]
            if path == "/":
                return self._send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            if path == "/api/state" and self._local():
                return self._json(200, bench.state())
            self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            path = self.path.split("?")[0]
            if not self._local():
                return self._json(403, {"error": "只接受本机页面的请求"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(length)) if 0 < length < 100_000 else {}
            except Exception:
                req = {}
            if path == "/api/reset":
                if not bench.busy.acquire(blocking=False):
                    return self._json(409, {"error": "有任务正在运行，等它结束再重置。"})
                try:
                    bench.reset()
                finally:
                    bench.busy.release()
                return self._json(200, bench.state())
            if path == "/api/stop":
                if bench.agent is not None:
                    bench.agent.interrupt()
                return self._json(200, {"ok": True})
            if path != "/api/run":
                return self._json(404, {"error": "not found"})
            task = str(req.get("task") or "").strip()
            if not task:
                return self._json(400, {"error": "任务不能为空。"})
            if not bench.busy.acquire(blocking=False):
                return self._json(409, {"error": "上一个任务还在运行。"})

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            events: queue.Queue = queue.Queue()

            def worker() -> None:
                try:
                    events.put({"type": "done", **asyncio.run(bench.run(task, events.put))})
                except Exception as e:  # 模型密钥没配、网络不通都从这里报给页面
                    events.put({"type": "error", "message": f"{type(e).__name__}: {e}"})
                finally:
                    bench.busy.release()
                    events.put(None)

            threading.Thread(target=worker, daemon=True).start()
            try:
                self._event({"type": "start", "task": task, "max_turns": bench.max_turns})
                while True:
                    try:
                        ev = events.get(timeout=10)
                    except queue.Empty:
                        self._chunk(b": keep-alive\n\n")
                        continue
                    if ev is None:
                        break
                    self._event(ev)
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass  # 页面关了，任务照常跑完

        def _event(self, ev: dict) -> None:
            self._chunk(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode())

        def _chunk(self, data: bytes) -> None:
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()

        def log_message(self, *args) -> None:
            pass

    return Handler


def serve(repo: Path, port: int = 8765, model_factory: Callable[[], ModelClient] = OpenAICompatModel,
          max_turns: int = 40) -> tuple[ThreadingHTTPServer, Workbench]:
    bench = Workbench(repo, model_factory, max_turns)
    # 只监听本机回环地址：这个服务能在你的电脑上执行命令，不能暴露到局域网
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(bench)), bench


def main() -> None:
    p = argparse.ArgumentParser(description="通用 Agent 的本地网页工作台")
    p.add_argument("--repo", default=str(ROOT / "fixtures" / "store"), help="让 Agent 干活的项目目录（会先复制一份）")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--max-turns", type=int, default=40)
    p.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = p.parse_args()
    httpd, bench = serve(Path(args.repo), args.port, max_turns=args.max_turns)
    url = f"http://127.0.0.1:{args.port}"
    print(f"工作台：{url}\n项目：{bench.repo}\n工作副本：{bench.workdir}\nCtrl+C 退出")
    if not args.no_open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        bench.close()


if __name__ == "__main__":
    main()
