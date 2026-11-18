"""环境检验：拿已知答案去考模拟环境本身。

四项都符合期望，只说明这个环境的行为合理且自洽，不说明它接近真实用户。
"""
from __future__ import annotations

from ..offline import POINTS, SEGMENTS
from ..types import Creative, Segment, SellingPoint
from .trial import SimEnv
from .users import behavior_features, build_pool


def fixture() -> tuple[list[SellingPoint], list[Segment]]:
    """检验用的固定卖点和人群（示例商品），不依赖前面环节的输出。"""
    points = [SellingPoint(i + 1, p["text"], p["category"], p["evidence"], p["source"], "verified", keywords=p["keywords"])
              for i, p in enumerate(POINTS[:7])]
    segments = []
    for i, s in enumerate(SEGMENTS[:3]):
        motives = [p.id for p in points if any(k in " ".join([p.text, *p.keywords]) for k in s["motive_keys"])][:2]
        segments.append(Segment(i + 1, s["name"], s["scenario"], motives, s["concerns"], s["avoid"], [], s["size_share"]))
    return points, segments


CASES = {
    "无关": "87 键机械键盘，热插拔轴体，打字手感清脆。",
    "对症": "不含酒精、不含香精，翻成分表就能确认，敏感肌换季也能用。",       # 针对敏感肌人群写的
    "违背": "户外暴晒必备！防晒力拉满，闭眼冲！！",                            # 对通勤人群强调他们不喜欢的点，语气夸张
    "普通": "50ml 便携装，放包里刚好。",
}


async def run_checks(models, sim: dict, behavior: str | None = None) -> list[dict]:
    from ..lead import ROOT
    points, segments = fixture()
    users = [u for u in build_pool(segments, points, behavior_features(behavior or ROOT / "data" / "behavior_sample.csv"), sim)
             if not u.holdout]
    env = SimEnv(models.stage("sim"), sim)
    seg_users = {s.id: [u for u in users if u.segment_id == s.id] for s in segments}
    targeted = [u for u in users if u.segment_id is not None]
    mk = lambda cid, key, seg=2: Creative(cid, seg, [], "场景", "理性", CASES[key])  # noqa: E731
    base = sim["base_ctr"]
    rows = []

    irrelevant = await env.true_rate(mk(901, "无关"), targeted)
    rows.append({"name": "无关素材", "ok": irrelevant < base * 1.5,
                 "detail": f"另一个品类的素材，期望点击率接近基准 {base:.1%}；实际 {irrelevant:.1%}"})

    normal = await env.true_rate(mk(902, "普通", 1), seg_users[1])
    against = await env.true_rate(mk(903, "违背", 1), seg_users[1])
    rows.append({"name": "违背顾虑的素材", "ok": against < normal,
                 "detail": f"对通勤人群强调他们反感的点，期望明显低于正常素材；{against:.1%} 对 {normal:.1%}"})

    own = await env.true_rate(mk(904, "对症"), seg_users[2])
    others = [await env.true_rate(mk(904, "对症"), seg_users[s]) for s in (1, 3)]
    rows.append({"name": "对症素材", "ok": own > max(others) * 1.2,
                 "detail": f"针对敏感肌人群写的一版，期望在该人群上明显高于其他人群；{own:.1%} 对 {max(others):.1%}"})

    # 重复运行：同一批素材换随机种子实际抽样两次，看排序是否一致
    batch = [mk(911, "对症"), mk(912, "普通"), mk(913, "违背"), mk(914, "无关")]
    orders = []
    for seed in (sim["seed"], sim["seed"] + 1):
        env.config = {**sim, "seed": seed}
        ctr = {}
        for c in batch:
            reactions = await env.expose(1, c, seg_users[2])
            ctr[c.id] = sum(r.clicked for r in reactions) / max(len(reactions), 1)
        orders.append(sorted(ctr, key=ctr.get, reverse=True))
    rows.append({"name": "重复运行", "ok": orders[0][0] == orders[1][0],
                 "detail": f"换一个随机种子重跑，期望最优素材不变；两次排序 {orders[0]} 与 {orders[1]}"})
    return rows
