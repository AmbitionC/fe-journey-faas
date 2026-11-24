"""斜杠命令：把常用的一长段任务说明存成文件，用 /名字 调出来。

和技能的区别在于谁来触发：技能是模型看了简介自己决定要不要加载，斜杠命令是用户明确地点名。
所以命令不占上下文（模型根本不知道有哪些命令），适合“每次都由我发起”的固定流程，例如提交前自查。

一个命令一个文件：.agent/commands/<名字>.md，开头可以写 description，正文里的 $ARGUMENTS 换成命令后面跟的内容。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .skills import parse_frontmatter


@dataclass
class Command:
    name: str
    description: str
    body: str

    def expand(self, arguments: str) -> str:
        if "$ARGUMENTS" in self.body:
            return self.body.replace("$ARGUMENTS", arguments)
        return self.body + (f"\n\n{arguments}" if arguments else "")


def discover_commands(commands_dir: Path) -> dict[str, Command]:
    found = {}
    if commands_dir.is_dir():
        for f in sorted(commands_dir.glob("*.md")):
            meta, body = parse_frontmatter(f.read_text(encoding="utf-8"))
            if body.strip():
                found[f.stem] = Command(f.stem, meta.get("description", ""), body.strip())
    return found


def parse(line: str) -> tuple[str, str] | None:
    """“/review 只看 cart.py” → ("review", "只看 cart.py")。不是斜杠命令返回 None。
    以 / 开头但像路径的（/usr/bin、/tmp/a.py）不算命令。"""
    if not line.startswith("/") or len(line) < 2:
        return None
    name, _, rest = line[1:].partition(" ")
    if not name or "/" in name or "." in name:
        return None
    return name, rest.strip()
