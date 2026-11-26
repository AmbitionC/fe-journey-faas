"""编辑预算：一代最多改多少，以及不许把题目写进规则里。

连续跑多代时，每一代的修改都是照着进化集上的失败提出来的。不加约束，后面几代会越改越多、
越改越贴着那几道题：进化集上的分数还在涨，换一套题却没用，用量还上去了。这里加三条约束，
都在花钱评测之前判，命中任何一条候选直接作废：

1. 改动量有上限，并且逐代收紧：越往后越只许微调。
2. 数值型配置一代最多调到原来的 2 倍（或一半）：挪一小步，看到效果再挪下一步。
3. 新加进来的内容里不许出现进化集题目特有的名字（任务编号、文件名、包名）。
"""
from __future__ import annotations

import json
import re
from difflib import SequenceMatcher

from ..harness import BOUNDS, Int, effective_config
from ..types import AgentVersion, Task

MAX_STEP = 2      # 数值型配置一代最多变成原来的几倍


def budget_at(generation: int, first: int, decay: float = 0.7, floor: int = 4) -> int:
    """第几代允许改多少行。first=20、decay=0.7 时是 20、14、9、6、4、4……"""
    return max(floor, int(first * decay ** (generation - 1)))


def lines_of(v: AgentVersion) -> list[str]:
    """把版本的四个内容字段摊成行。经验条目的功过计数不算内容。"""
    return (v.system_prompt.splitlines() + [f"[{i.id}] {i.content}" for i in v.playbook]
            + [f"{k} = {json.dumps(val, ensure_ascii=False)}" for k, val in sorted(v.config)] + v.code.splitlines())


def diff(before: AgentVersion, after: AgentVersion) -> tuple[int, list[str]]:
    """返回（改动行数，新增或改写后的行）。改写一行算一行，不是删一行加一行。"""
    a, b = lines_of(before), lines_of(after)
    size, added = 0, []
    for op, i1, i2, j1, j2 in SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op != "equal":
            size += max(i2 - i1, j2 - j1)
            added += b[j1:j2]
    return size, added


def task_terms(tasks: list[Task]) -> list[str]:
    """进化集题目特有的名字：任务编号、仓库里的文件名和包名。提案器只见过进化集，要防的就是它们。"""
    terms: set[str] = set()
    for t in tasks:
        terms.add(t.id)
        for p in t.repo.rglob("*.py"):
            if p.name != "__init__.py":
                terms.add(p.name)
        terms.update(d.name for d in t.repo.iterdir() if d.is_dir() and d.name not in ("tests", "__pycache__"))
    return sorted(terms)


def violations(before: AgentVersion, after: AgentVersion, budget: int | None, terms: list[str]) -> tuple[str, str]:
    """返回（命中的规则，说明）；都没命中返回 ("", "")。"""
    size, added = diff(before, after)
    if budget is not None and size > budget:
        return "budget", f"改动 {size} 行，超出这一代的上限 {budget} 行"
    if budget is not None:
        old, new = effective_config(before.config_dict), effective_config(after.config_dict)
        for key, bound in BOUNDS.items():
            if isinstance(bound, Int) and not old[key] / MAX_STEP <= new[key] <= old[key] * MAX_STEP:
                return "step", (f"{key} 从 {old[key]} 调到 {new[key]}，一代最多调到原来的 {MAX_STEP} 倍"
                                f"（{old[key] // MAX_STEP}～{old[key] * MAX_STEP}）")
    text = "\n".join(added)
    hit = [t for t in terms if re.search(rf"(?<![A-Za-z0-9_]){re.escape(t)}(?![A-Za-z0-9_])", text)]
    if hit:
        return "specific", f"修改里出现了具体题目的名字（{'、'.join(hit[:3])}），这样的规则换一道题就没用"
    return "", ""
