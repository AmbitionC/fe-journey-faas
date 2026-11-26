"""第二级进化：增量维护经验手册（ACE 的思路）。

只做增量修改（加一条、改一条、给一条记功过），不让模型重写整本手册：
整本重写几轮之后，具体的经验会被越写越泛，最后只剩“注意验证”这种没用的话。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, replace
from difflib import SequenceMatcher

from ..types import AgentVersion, PlaybookItem, RunRecord, Task
from .common import example_block, extract_json
from .gate import Bench, Decision, admit

SECTIONS = ("定位", "修改", "验证", "沟通")

SYSTEM = "你在维护一个编程 Agent 的经验手册。手册里的每一条都应该是具体、可执行的做法。"
TEMPLATE = """当前手册：
{playbook}

下面是 Agent 带着这本手册完成的几次任务：

{examples}

请对照结果提炼教训，并给出对手册的增量修改。只输出一个 JSON 数组，每个元素是下面三种之一：
{{"op": "add", "section": "定位|修改|验证|沟通", "content": "一条具体的经验"}}
{{"op": "update", "item_id": "已有条目的编号", "content": "改写后的内容"}}
{{"op": "mark", "item_id": "已有条目的编号", "helpful": 1}}   或   {{"op": "mark", "item_id": "…", "harmful": 1}}

要求：
- 经验要具体到“在什么情况下、做什么、为什么”。差：“注意验证修改。”
  好：“改完代码后重新运行最初失败的那条测试，看到通过再回复；只读代码判断会漏掉取整这类细节。”
- 不要写只对某一条任务成立的内容（具体的文件名、数值）。
- 手册里已有的经验不要重复添加；它这次起了作用就 mark helpful，起了误导就 mark harmful。
- 没有值得记的就输出 []。"""


@dataclass
class Delta:
    op: str
    item_id: str | None = None
    section: str | None = None
    content: str | None = None
    helpful: int = 0
    harmful: int = 0


def parse_deltas(data) -> list[Delta]:
    out = []
    for d in data if isinstance(data, list) else []:
        if not isinstance(d, dict) or d.get("op") not in ("add", "update", "mark"):
            continue
        content = str(d.get("content") or "").strip()
        if d["op"] == "add" and content and d.get("section") in SECTIONS:
            out.append(Delta("add", section=d["section"], content=content[:400]))
        elif d["op"] == "update" and content and d.get("item_id"):
            out.append(Delta("update", item_id=str(d["item_id"]), content=content[:400]))
        elif d["op"] == "mark" and d.get("item_id"):
            out.append(Delta("mark", item_id=str(d["item_id"]), helpful=int(bool(d.get("helpful"))),
                             harmful=int(bool(d.get("harmful")))))
    return out


SLUG = {"定位": "locate", "修改": "edit", "验证": "verify", "沟通": "report"}


def next_id(section: str, items: dict[str, PlaybookItem]) -> str:
    prefix = SLUG.get(section, "misc")
    used = [int(m.group(1)) for i in items if (m := re.fullmatch(rf"{prefix}-(\d+)", i))]
    return f"{prefix}-{max(used, default=0) + 1:03d}"


def apply(playbook: list[PlaybookItem], deltas: list[Delta], created_in: str = "") -> list[PlaybookItem]:
    """把增量修改作用到手册上。指向不存在条目的修改直接忽略。"""
    items = {i.id: i for i in playbook}
    for d in deltas:
        if d.op == "add":
            if any(similar(d.content or "", i.content) > 0.9 for i in items.values()):
                continue            # 近似重复的不加
            new_id = next_id(d.section or "", items)
            items[new_id] = PlaybookItem(new_id, d.section or "", d.content or "", created_in=created_in)
        elif d.op == "update" and d.item_id in items:
            items[d.item_id] = replace(items[d.item_id], content=d.content or items[d.item_id].content)
        elif d.op == "mark" and d.item_id in items:
            it = items[d.item_id]
            items[d.item_id] = replace(it, helpful=it.helpful + d.helpful, harmful=it.harmful + d.harmful)
    return list(items.values())


def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def refine(items: list[PlaybookItem], budget_chars: int = 3000) -> list[PlaybookItem]:
    """整理：淘汰被反复认定有误导的条目；超出预算时按“有用次数 − 误导次数”保留靠前的。"""
    kept = [i for i in items if not (i.harmful >= 3 and i.harmful > i.helpful)]
    if sum(len(i.content) for i in kept) > budget_chars:
        ranked = sorted(kept, key=lambda i: i.helpful - i.harmful, reverse=True)
        total, chosen = 0, set()
        for i in ranked:
            if total + len(i.content) <= budget_chars:
                chosen.add(i.id)
                total += len(i.content)
        kept = [i for i in kept if i.id in chosen]      # 保持原有顺序
    return kept


def render(items: list[PlaybookItem]) -> str:
    return "\n".join(f"[{i.id}]（{i.section}，有用 {i.helpful} / 误导 {i.harmful}）{i.content}" for i in items) or "（空）"


async def evolve_playbook(bench: Bench, model, current: AgentVersion, batch_size: int = 4
                          ) -> tuple[AgentVersion, Decision | None]:
    evolve_set = bench.split("evolve")
    tasks: dict[str, Task] = {t.id: t for t in evolve_set}
    records: list[RunRecord] = await bench.run(current, evolve_set, "基线·进化集")
    shown = ([r for r in records if not r.passed] + [r for r in records if r.passed])[:batch_size]
    data = extract_json(await model.ask(SYSTEM, TEMPLATE.format(
        playbook=render(list(current.playbook)),
        examples="\n\n".join(example_block(tasks[r.task_id].prompt, r) for r in shown)) + bench.limits()))
    deltas = parse_deltas(data)
    before = list(current.playbook)
    after = refine(apply(before, deltas, created_in=current.id))
    added = len({i.id for i in after} - {i.id for i in before})
    removed = len({i.id for i in before} - {i.id for i in after})
    updated = sum(1 for i in after for j in before if i.id == j.id and i.content != j.content)
    bench.notify("proposal", {"level": 2, "added": added, "updated": updated, "removed": removed,
                              "changed": bool(added or updated or removed)})
    if not (added or updated or removed):
        # 只有记功过没有内容变化：手册对 Agent 来说没变，不需要过闸门
        return (current if tuple(after) == current.playbook else
                current.derive("更新经验条目的功过计数", playbook=after)), None
    candidate = current.derive(f"经验手册：新增 {added} 条，修改 {updated} 条，淘汰 {removed} 条", playbook=after)
    decision = await admit(bench, candidate, current)
    return (candidate if decision.admitted else current), decision
