"""技能：三级按需加载。第一级只把 name 和 description 放进上下文，用到时才读 SKILL.md 全文。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..tools.registry import tool
from ..types import Tool


@dataclass
class Skill:
    name: str
    description: str
    path: Path  # SKILL.md


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---"):
        return {}, text
    head, _, body = text[3:].partition("\n---")
    meta = {}
    for line in head.strip().splitlines():
        key, sep, value = line.partition(":")
        if sep:
            meta[key.strip()] = value.strip()
    return meta, body.lstrip("\n")


def discover(skills_dir: Path) -> list[Skill]:
    found = []
    if not skills_dir.is_dir():
        return found
    for f in sorted(skills_dir.glob("*/SKILL.md")):
        meta, _ = parse_frontmatter(f.read_text(encoding="utf-8"))
        if meta.get("name") and meta.get("description"):  # 缺任何一个字段的技能不会被模型选中，直接跳过
            found.append(Skill(meta["name"], meta["description"], f))
    return found


def skills_index(skills: list[Skill]) -> str:
    return "\n".join(f"- {s.name}：{s.description}" for s in skills)


def skill_tool(skills: list[Skill], root: Path) -> Tool:
    by_name = {s.name: s for s in skills}

    @tool(read_only=True)
    async def load_skill(name: str) -> str:
        """读入一个技能的完整说明。当前任务和某个技能的简介匹配时，先加载它再动手。

        Args:
            name: 技能名，见系统提示词里的技能列表
        """
        s = by_name.get(name)
        if s is None:
            return f"没有名为 {name} 的技能。可用的有：{'、'.join(by_name) or '（无）'}"
        _, body = parse_frontmatter(s.path.read_text(encoding="utf-8"))
        others = [p.name for p in s.path.parent.iterdir() if p.name != "SKILL.md"]
        try:
            where = s.path.parent.relative_to(root)
        except ValueError:
            where = s.path.parent
        extra = f"\n\n（技能目录 {where} 下还有：{'、'.join(others)}。正文提到时再用 read_file 读取或用 run_command 执行。）" if others else ""
        return body + extra

    return load_skill
