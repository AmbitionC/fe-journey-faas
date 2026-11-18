"""沙箱服务：收到一批文件和一条命令，在全新的临时目录里执行，返回输出和文件变化。

部署要求（由部署配置保证，不由这段代码保证）：关闭公网出站、不挂任何密钥和角色、单实例单并发。
这段代码自己做的：校验调用令牌、清空环境变量、限制时长和输出大小、跑完即删。
只用标准库。
"""
from __future__ import annotations

import hmac
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = os.environ.get("SANDBOX_TOKEN", "")
PORT = int(os.environ.get("FC_SERVER_PORT") or os.environ.get("PORT") or 9000)
MAX_BODY = 3_000_000
MAX_OUTPUT = 20_000
MAX_TIMEOUT = 60
MAX_FILE = 200_000
SKIP = {"__pycache__", ".pytest_cache"}


def safe_rel(path: str) -> bool:
    parts = Path(path).parts
    return bool(parts) and not Path(path).is_absolute() and ".." not in parts and len(path) < 300


def snapshot(root: Path) -> dict[str, str]:
    out = {}
    for p in root.rglob("*"):
        if p.is_file() and not p.is_symlink() and not SKIP & set(p.parts) and p.stat().st_size <= MAX_FILE:
            try:
                out[str(p.relative_to(root))] = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
    return out


def execute(files: dict[str, str], command: str, timeout: int) -> dict:
    root = Path(tempfile.mkdtemp(prefix="sandbox-"))
    try:
        for rel, content in files.items():
            if not safe_rel(rel):
                continue
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        before = snapshot(root)
        env = {"PATH": os.environ.get("SANDBOX_PATH") or f"{Path(sys.executable).parent}:/usr/bin:/bin",
               "HOME": str(root), "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
        proc = subprocess.Popen(command, shell=True, cwd=root, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        timed_out = False
        try:
            out, _ = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            out, _ = proc.communicate()
        text = out.decode(errors="replace")
        if len(text) > MAX_OUTPUT:
            text = text[: MAX_OUTPUT // 2] + "\n……（输出过长，中间已省略）……\n" + text[-MAX_OUTPUT // 2:]
        after = snapshot(root)
        return {"exit_code": proc.returncode, "timed_out": timed_out, "output": text,
                "changed": {k: v for k, v in after.items() if before.get(k) != v},
                "deleted": [k for k in before if k not in after]}
    finally:
        shutil.rmtree(root, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        self._json(200, {"ok": True, "python": sys.version.split()[0], "token_configured": bool(TOKEN)})

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/exec":
            return self._json(404, {"error": "not found"})
        # 没配令牌时拒绝一切调用
        if not TOKEN or not hmac.compare_digest(self.headers.get("X-Sandbox-Token", ""), TOKEN):
            return self._json(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            return self._json(413, {"error": "body too large"})
        try:
            req = json.loads(self.rfile.read(length))
            files, command = req["files"], str(req["command"])
            timeout = max(1, min(int(req.get("timeout", 30)), MAX_TIMEOUT))
            assert isinstance(files, dict)
        except Exception:
            return self._json(400, {"error": "bad request"})
        self._json(200, execute(files, command, timeout))

    def log_message(self, *args) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
