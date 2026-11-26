"""从 Markdown 文本生成目录树。

只认行首的 # 标题（1 到 6 级），代码块里的 # 不算。同名标题的锚点后面加序号。
"""
import re
from dataclasses import dataclass, field

HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
FENCE = re.compile(r"^(```|~~~)")


@dataclass
class Entry:
    level: int
    title: str
    anchor: str
    children: list["Entry"] = field(default_factory=list)


def slug(title: str) -> str:
    """标题转锚点：小写，空白变短横线，去掉标点。"""
    text = re.sub(r"[^\w\u4e00-\u9fff\s-]", "", title.lower())
    return re.sub(r"\s+", "-", text.strip())


def headings(markdown: str) -> list[tuple[int, str]]:
    """按出现顺序返回（级别，标题）。"""
    out, in_code = [], False
    for line in markdown.splitlines():
        if FENCE.match(line.strip()):
            in_code = not in_code
            continue
        if in_code:
            continue
        m = HEADING.match(line)
        if m and m.group(2):
            out.append((len(m.group(1)), m.group(2)))
    return out


def build(markdown: str) -> list[Entry]:
    """生成目录树。标题跳级（比如一级下面直接是三级）时，挂到最近的上级标题下面。"""
    roots: list[Entry] = []
    stack: list[Entry] = []          # 从根到当前位置的一条路径
    seen: dict[str, int] = {}
    for level, title in headings(markdown):
        base = slug(title)
        count = seen.get(base, 0)
        seen[base] = count + 1
        entry = Entry(level, title, base if count == 0 else f"{base}-{count}")
        # 回到更高或同级的标题：把路径上级别不比它高的都弹掉
        while stack and stack[-1].level >= level:
            stack.pop()
        (stack[-1].children if stack else roots).append(entry)
        stack.append(entry)
    return roots


def render(entries: list[Entry], indent: int = 0) -> str:
    """把目录树渲染成缩进的 Markdown 列表。"""
    lines = []
    for e in entries:
        lines.append(f"{'  ' * indent}- [{e.title}](#{e.anchor})")
        if e.children:
            lines.append(render(e.children, indent + 1))
    return "\n".join(lines)


def flatten(entries: list[Entry]) -> list[Entry]:
    out = []
    for e in entries:
        out.append(e)
        out.extend(flatten(e.children))
    return out
