"""记忆的离线整理：不在任务进行时做，而是在两次任务之间专门跑一遍。

任务中途写记忆只能做到“写入前查重”。时间长了仍然会攒下三类问题：
说的是同一件事但用词不同、没被查重合并的；互相矛盾的；标题写得太泛、看标题判断不了相不相关的。
整理由模型出方案、由代码执行：模型只输出“合并哪几条、删哪条、哪条标题要改”，
代码校验编号是否存在、有没有一条被处理两次，再在一个事务里应用。
被合并和被删除的原文都先进归档表，整理错了可以找回来。
"""
from __future__ import annotations

import json
import re
import time

from ..model import ModelClient
from ..types import Message
from .memory import MemoryStore

DREAM_PROMPT = """下面是一个编程助手积累的全部长期记忆。请整理它们，只输出一个 JSON 对象：
{"merge": [{"ids": [编号, 编号], "kind": "preference|fact|lesson", "title": "合并后的标题", "content": "合并后的正文"}],
 "delete": [{"id": 编号, "reason": "为什么可以删"}],
 "retitle": [{"id": 编号, "title": "新标题"}]}

规则：
- 说的是同一件事的合并成一条；互相矛盾的以更新时间较晚的为准，合并后的正文里写明旧说法已作废。
- 只删这两类：记的是某次任务的进度或结果；能从代码里直接读出来的事实。拿不准就不删。
- 标题太泛（看标题判断不了和当前任务相不相关）的改标题，正文不动。
- 一条记忆最多出现在一个操作里。没有要做的就给空数组。"""


def _plan(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    try:
        out = json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        out = {}
    return out if isinstance(out, dict) else {}


async def consolidate(store: MemoryStore, model: ModelClient) -> str:
    """整理当前项目看得到的记忆，返回一份说明做了什么的报告。"""
    rows = {r[0]: r for r in store._rows()}
    if len(rows) < 2:
        return "记忆不足两条，不需要整理。"
    listing = "\n\n".join(f"#{rid} [{kind}]（更新于 {updated}，被取用 {hits} 次）{title}\n{content}"
                          for rid, kind, title, content, updated, hits in rows.values())
    reply, _ = await model.chat([Message("system", DREAM_PROMPT), Message("user", listing)], [])
    plan, used, report = _plan(reply.content), set(), []
    now = time.strftime("%Y-%m-%d")
    db = store.db
    db.execute("""CREATE TABLE IF NOT EXISTS memory_archive (
        id INTEGER, kind TEXT, title TEXT, content TEXT, scope TEXT, archived_at TEXT, why TEXT)""")

    def archive(rid: int, why: str) -> None:
        db.execute("INSERT INTO memory_archive SELECT id, kind, title, content, scope, ?, ? FROM memory WHERE id=?",
                   (now, why, rid))

    def fresh(ids) -> bool:      # 编号都存在、都没被别的操作用过
        return all(isinstance(i, int) and i in rows and i not in used for i in ids)

    for m in plan.get("merge") or []:
        ids = m.get("ids") or []
        if len(ids) < 2 or len(set(ids)) != len(ids) or not fresh(ids) or not m.get("title") or not m.get("content") \
                or m.get("kind") not in ("preference", "fact", "lesson"):
            continue
        used.update(ids)
        keep = min(ids)
        for rid in ids:
            archive(rid, f"合并进 #{keep}")
        hits = sum(rows[i][5] for i in ids)
        db.execute("UPDATE memory SET kind=?, title=?, content=?, updated_at=?, hits=? WHERE id=?",
                   (m["kind"], m["title"], m["content"], now, hits, keep))
        db.executemany("DELETE FROM memory WHERE id=?", [(i,) for i in ids if i != keep])
        report.append(f"合并 {'、'.join(f'#{i}' for i in ids)} → #{keep} {m['title']}")
    for d in plan.get("delete") or []:
        rid = d.get("id")
        if not fresh([rid]):
            continue
        used.add(rid)
        archive(rid, f"删除：{d.get('reason', '')}")
        db.execute("DELETE FROM memory WHERE id=?", (rid,))
        report.append(f"删除 #{rid} {rows[rid][2]}（{d.get('reason', '未说明')}）")
    for t in plan.get("retitle") or []:
        rid = t.get("id")
        if not fresh([rid]) or not t.get("title"):
            continue
        used.add(rid)
        db.execute("UPDATE memory SET title=? WHERE id=?", (t["title"], rid))
        report.append(f"改标题 #{rid}：{rows[rid][2]} → {t['title']}")
    db.commit()
    if not report:
        return f"看过了 {len(rows)} 条记忆，没有需要整理的。"
    return f"整理前 {len(rows)} 条，整理后 {len(store._rows())} 条。被合并和删除的原文在归档表里，可以找回。\n" + "\n".join(report)
