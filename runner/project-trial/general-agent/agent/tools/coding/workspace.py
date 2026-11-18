"""工作目录：所有文件工具共用的路径边界和“已读”状态。"""
from __future__ import annotations

import difflib
from pathlib import Path

IGNORED_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".pytest_cache", ".agent"}
SENSITIVE_NAMES = (".env", "id_rsa", "id_ed25519", ".pem", "credentials")


class PathError(Exception):
    pass


class Workspace:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self._read: dict[Path, float] = {}  # 路径 -> 读取时的修改时间

    def resolve(self, path: str) -> Path:
        """解析成绝对路径并展开符号链接，结果必须在项目目录之内。"""
        p = Path(path)
        full = (p if p.is_absolute() else self.root / p).resolve()
        if full != self.root and self.root not in full.parents:
            raise PathError(f"路径 {path} 在项目目录 {self.root} 之外，不允许访问。")
        return full

    def rel(self, full: Path) -> str:
        return str(full.relative_to(self.root)) if full != self.root else "."

    def is_sensitive(self, path: str) -> bool:
        name = Path(path).name.lower()
        return any(name == s or name.endswith(s) or name.startswith(s + ".") for s in SENSITIVE_NAMES)

    def mark_read(self, full: Path) -> None:
        self._read[full] = full.stat().st_mtime

    def check_fresh(self, full: Path) -> str | None:
        """改文件之前必须读过，且读过之后文件没有被别处改动。"""
        if full not in self._read:
            return f"修改 {self.rel(full)} 之前必须先用 read_file 读取它。"
        if full.stat().st_mtime != self._read[full]:
            return f"{self.rel(full)} 在你读取之后被修改过，请重新读取再改。"
        return None

    def similar(self, path: str, n: int = 3) -> list[str]:
        names = [self.rel(p) for p in self.walk()]
        target = Path(path).name
        close = difflib.get_close_matches(target, [Path(x).name for x in names], n=n, cutoff=0.5)
        return [x for x in names if Path(x).name in close][:n]

    def walk(self):
        stack = [self.root]
        while stack:
            d = stack.pop()
            try:
                entries = sorted(d.iterdir())
            except OSError:
                continue
            for e in entries:
                if e.is_dir():
                    if e.name not in IGNORED_DIRS and not e.is_symlink():
                        stack.append(e)
                elif e.is_file():
                    yield e
