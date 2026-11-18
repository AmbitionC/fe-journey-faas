"""读、写、改、按名查找、按内容搜索。"""
from __future__ import annotations

import fnmatch
import re

from ...types import Tool
from ..registry import tool
from .workspace import PathError, Workspace


def file_tools(ws: Workspace) -> list[Tool]:
    @tool(read_only=True)
    async def read_file(path: str, offset: int = 0, limit: int = 2000) -> str:
        """读取文本文件的内容，返回带行号的文本。

        文件较大时用 offset 和 limit 分段读取。修改文件之前必须先读取它。

        Args:
            path: 相对于工作目录的文件路径
            offset: 从第几行开始，0 表示开头
            limit: 最多读取多少行
        """
        try:
            full = ws.resolve(path)
        except PathError as e:
            return str(e)
        if not full.is_file():
            hint = ws.similar(path)
            extra = f"名称相近的文件有：{'、'.join(hint)}" if hint else "可以用 find_files 查找。"
            return f"文件 {path} 不存在。{extra}"
        try:
            lines = full.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            return f"{path} 不是 UTF-8 文本文件，无法读取。"
        ws.mark_read(full)
        chunk = lines[offset: offset + limit]
        body = "\n".join(f"{i + 1:>5}\t{line}" for i, line in enumerate(chunk, start=offset))
        rest = len(lines) - offset - len(chunk)
        if rest > 0:
            body += f"\n（还有 {rest} 行，用 offset={offset + len(chunk)} 继续读取）"
        return body or "（空文件）"

    @tool()
    async def write_file(path: str, content: str) -> str:
        """创建一个新文件，或整体覆盖一个已有文件。

        覆盖已有文件之前必须先读取它。只改其中一小段时请用 edit_file。

        Args:
            path: 相对于工作目录的文件路径
            content: 文件的完整内容
        """
        try:
            full = ws.resolve(path)
        except PathError as e:
            return str(e)
        if full.exists():
            problem = ws.check_fresh(full)
            if problem:
                return problem
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
        ws.mark_read(full)
        return f"已写入 {ws.rel(full)}（{len(content.splitlines())} 行）。"

    @tool()
    async def edit_file(path: str, old_text: str, new_text: str) -> str:
        """把文件里的一段文字替换成另一段。

        old_text 必须和文件内容逐字一致（含缩进），并且在文件里只出现一次。
        出现多次时请多带几行上下文让它唯一。

        Args:
            path: 相对于工作目录的文件路径
            old_text: 要被替换的原文
            new_text: 替换成的新内容
        """
        try:
            full = ws.resolve(path)
        except PathError as e:
            return str(e)
        if not full.is_file():
            return f"文件 {path} 不存在。新建文件请用 write_file。"
        problem = ws.check_fresh(full)
        if problem:
            return problem
        text = full.read_text(encoding="utf-8")
        count = text.count(old_text)
        if count == 0:
            return f"在 {path} 里没有找到 old_text。请重新读取文件，确认原文逐字一致（注意缩进和空格）。"
        if count > 1:
            return f"old_text 在 {path} 里出现了 {count} 次。请多带几行上下文，让它只匹配一处。"
        full.write_text(text.replace(old_text, new_text, 1), encoding="utf-8")
        ws.mark_read(full)
        return f"已修改 {ws.rel(full)}。"

    @tool(read_only=True)
    async def find_files(pattern: str) -> str:
        """按通配符查找文件，返回相对路径列表。默认忽略依赖目录和构建产物。

        Args:
            pattern: 通配符，如 *.py 或 tests/test_*.py
        """
        hits = [ws.rel(p) for p in ws.walk()
                if fnmatch.fnmatch(ws.rel(p), pattern) or fnmatch.fnmatch(p.name, pattern)]
        if not hits:
            return f"没有文件匹配 {pattern}。"
        shown = sorted(hits)[:200]
        more = f"\n（共 {len(hits)} 个，只显示前 200 个，请缩小范围）" if len(hits) > 200 else ""
        return "\n".join(shown) + more

    @tool(read_only=True)
    async def search_text(pattern: str, glob: str = "*") -> str:
        """在文件内容里搜索正则表达式，返回匹配行及其文件路径和行号。

        不知道某段代码在哪个文件时使用。已经知道文件路径时，直接用 read_file。

        Args:
            pattern: 正则表达式
            glob: 只在文件名匹配该通配符的文件里搜索，如 *.py
        """
        try:
            rx = re.compile(pattern)
        except re.error as e:
            return f"正则表达式有误：{e}"
        out: list[str] = []
        for p in ws.walk():
            if not fnmatch.fnmatch(p.name, glob):
                continue
            try:
                for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                    if rx.search(line):
                        out.append(f"{ws.rel(p)}:{n}: {line.strip()[:200]}")
                        if len(out) >= 100:
                            return "\n".join(out) + "\n（结果超过 100 条，已截断，请缩小范围）"
            except (UnicodeDecodeError, OSError):
                continue
        return "\n".join(out) or f"没有内容匹配 {pattern}。"

    return [read_file, write_file, edit_file, find_files, search_text]
