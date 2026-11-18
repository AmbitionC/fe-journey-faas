"""给人看的输出：最终报告、素材谱系、成本表。所有出现效果数字的地方都带上模拟环境的说明。"""
from __future__ import annotations

from .stages.attribute import summarize


def disclaimer(sim: dict, users: int) -> str:
    return (f"以下数据来自模拟试投环境（配置 {sim['name']}，模拟用户 {users} 人，随机种子 {sim['seed']}）。\n"
            "模拟用户的行为特征抽样自行为数据样例，人群设定与偏好为合成。\n"
            "这些数字用于比较素材之间的相对表现，不代表真实投放效果。")


def lineage(store, summary: dict | None = None) -> str:
    """素材谱系：一版素材是怎样一步步改出来的。"""
    creatives = store.creatives()
    summary = summary if summary is not None else summarize(store.impressions())
    children: dict[int | None, list] = {}
    for c in creatives:
        children.setdefault(c.parent_id, []).append(c)
    mark = {"approved": "", "retired": "（已淘汰）", "rejected": "（审核未过）", "draft": "（草稿）"}
    lines = []

    def walk(c, prefix: str, last: bool, root: bool) -> None:
        s = summary.get(c.id)
        perf = f"{s['ctr']:.1%}（{s['n']} 次曝光）" if s else "未投放"
        head = "" if root else prefix + ("└─" if last else "├─")
        lines.append(f"{head}#{c.id} {c.angle}｜{c.tone}　“{c.body}”　第{c.round}轮　{perf}{mark.get(c.status, '')}")
        kids = children.get(c.id, [])
        for i, k in enumerate(kids):
            walk(k, prefix + ("" if root else ("  " if last else "│ ")) + " ", i == len(kids) - 1, False)

    names = {s.id: s.name for s in store.segments(active_only=False)}
    for seg_id in sorted(names):
        roots = [c for c in children.get(None, []) if c.segment_id == seg_id]
        if roots:
            lines.append(f"【{names[seg_id]}】")
            for r in roots:
                walk(r, "", True, True)
    return "\n".join(lines)


def costs(rows: list[dict]) -> str:
    lines = ["环节　　　　调用次数　缓存命中　输入用量　输出用量　耗时(秒)"]
    for r in rows:
        lines.append(f"{r['stage']:<10}{r['calls']:>8}{r.get('cache_hits', 0):>9}{r['input_tokens'] or 0:>10}"
                     f"{r['output_tokens'] or 0:>10}{(r['ms'] or 0) / 1000:>10.1f}")
    return "\n".join(lines)


def final_report(campaign, holdout: dict) -> str:
    store, cfg, state = campaign.store, campaign.config, campaign.state
    creatives = store.creatives()
    count = lambda status: sum(c.status == status for c in creatives)  # noqa: E731
    product = store.product()
    lines = [f"活动报告：{product.name}（模拟环境 {campaign.sim['name']}）", "",
             f"共 {state['round']} 轮，使用预算 {store.used_budget()} / {cfg.budget}",
             f"生成素材 {len(creatives)} 版，审核拦截 {count('rejected')} 版，淘汰 {count('retired')} 版，"
             f"最终保留 {count('approved')} 版",
             f"停止原因：{state['stop']}", "", "各人群最终推荐"]
    by_id = {c.id: c for c in creatives}
    for seg in store.segments(active_only=False):
        row = holdout.get(seg.id)
        if row is None:
            lines.append(f"  {seg.name}　没有可比较的数据" + ("（已放弃）" if seg.id not in {s.id for s in store.segments()} else ""))
            continue
        c = by_id[row["final"]]
        settled = "" if row["prob_best"] > cfg.stop_prob else f"　尚未收敛（是最优的概率 {row['prob_best']:.2f}）"
        if "lift" not in row:
            lines.append(f"  {seg.name}　#{c.id}　{c.angle}｜{c.tone}　与首轮最优是同一版，没有可报告的提升{settled}")
            continue
        sig = "" if row["lo"] > 0 else "，未达到显著"
        lines.append(f"  {seg.name}　#{c.id}　{c.angle}｜{c.tone}　留出用户上相对首轮最优素材 #{row['first']} {row['lift']:+.0%}"
                     f"（区间 {row['lo']:+.0%} 至 {row['hi']:+.0%}{sig}，留出用户 {row['n']} 人）{settled}")
        lines.append(f"      “{c.body}”")
    strong = [(r, f) for r, f in store.findings() if f.confidence in ("high", "medium") and f.kind in ("works", "fails")]
    names = {s.id: s.name for s in store.segments(active_only=False)}
    seen, top = set(), []
    for r, f in reversed(strong):
        if (f.segment_id, f.statement) not in seen:
            seen.add((f.segment_id, f.statement))
            top.append(f"对{names.get(f.segment_id, '')}，{f.statement}（{'高' if f.confidence == 'high' else '中'}置信，第 {r} 轮）")
    baits = [b for r in range(1, state["round"] + 1) for b in store.get(f"clickbait:{r}", []) if b["confirmed"]]
    if top or store.questions() or baits:
        lines += ["", "主要发现"]
        lines += [f"  {i}. {t}" for i, t in enumerate(top[:5] + store.questions()
                                                 + ([f"出现 {len(baits)} 版标题党素材，已淘汰"] if baits else []), 1)]
    rates = state["block_rates"]
    if rates:
        lines += ["", "各轮审核首次送审未通过的比例：" + "、".join(f"{rates[k]:.0%}" for k in sorted(rates, key=int))]
    lines += ["", disclaimer(campaign.sim, len(campaign.users))]
    return "\n".join(lines)
