"""模拟用户池：行为特征来自行为数据，人群设定与个体差异是合成的。这条界线在这里和 README 里都标明。

每个模拟用户 = 一类目标人群 × 一个从行为数据里抽出来的用户的统计量 + 合成的个体差异。
人群和行为类型独立抽样：每类人群里各种行为类型的比例都和总体一致。这是一个简化假设。
"""
from __future__ import annotations

import csv
import math
import random
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

from ..types import Segment, SellingPoint, SimUser

FEATURES = ("buy_per_pv", "hesitation", "focus", "night_share", "pv")
TZ = timezone(timedelta(hours=8))


def behavior_features(path: str | Path) -> dict[int, dict]:
    """对每个用户算一组统计量。输入是 user_id,item_id,category_id,behavior,timestamp 的 CSV。"""
    raw: dict[int, dict] = defaultdict(lambda: {"pv": 0, "buy": 0, "cart_or_fav": 0, "cats": set(), "night": 0, "n": 0})
    with open(path, newline="") as f:
        for uid, _item, cat, behavior, ts in csv.reader(f):
            u = raw[int(uid)]
            u["n"] += 1
            u["cats"].add(cat)
            u["night"] += datetime.fromtimestamp(int(ts), TZ).hour >= 21
            if behavior == "pv":
                u["pv"] += 1
            elif behavior == "buy":
                u["buy"] += 1
            else:
                u["cart_or_fav"] += 1
    feats = {}
    for uid, u in raw.items():
        feats[uid] = {
            "pv": u["pv"], "buy": u["buy"], "cart_or_fav": u["cart_or_fav"], "categories": len(u["cats"]),
            "night_share": u["night"] / u["n"],
            "buy_per_pv": u["buy"] / max(u["pv"], 1),                                   # 看多少次买一次
            "hesitation": u["cart_or_fav"] / max(u["buy"] + u["cart_or_fav"], 1),       # 加购收藏但没买的倾向
            "focus": 1 / max(len(u["cats"]), 1),                                        # 兴趣集中程度
        }
    mean = sum(f["buy_per_pv"] for f in feats.values()) / max(len(feats), 1)
    for f in feats.values():   # 平均水平的用户取 1；截断到 0.2~3，免得个别用户把下单概率拉到离谱
        f["buy_per_pv_scaled"] = min(max(f["buy_per_pv"] / mean if mean else 1.0, 0.2), 3.0)
    return feats


def kmeans(feats: dict[int, dict], k: int = 4, seed: int = 0, iters: int = 30) -> tuple[dict[int, int], float]:
    """对标准化后的行为特征做 K-means。返回每个用户的类别和平均轮廓系数的近似值（越高分得越开）。"""
    ids = sorted(feats)
    cols = []
    for name in FEATURES:
        vals = [math.log1p(feats[i][name]) if name == "pv" else feats[i][name] for i in ids]
        mu = sum(vals) / len(vals)
        sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / len(vals)) or 1.0
        cols.append([(v - mu) / sd for v in vals])
    X = list(zip(*cols))
    rng = random.Random(seed)
    centers = rng.sample(X, k)
    dist = lambda a, b: sum((x - y) ** 2 for x, y in zip(a, b))  # noqa: E731
    labels = [0] * len(X)
    for _ in range(iters):
        labels = [min(range(k), key=lambda c: dist(x, centers[c])) for x in X]
        for c in range(k):
            members = [x for x, lab in zip(X, labels) if lab == c]
            if members:
                centers[c] = tuple(sum(col) / len(members) for col in zip(*members))
    # 简化的轮廓系数：用到本类中心和最近的其他类中心的距离代替两两距离
    score = 0.0
    for x, lab in zip(X, labels):
        a = math.sqrt(dist(x, centers[lab]))
        b = min(math.sqrt(dist(x, centers[c])) for c in range(k) if c != lab)
        score += (b - a) / max(a, b, 1e-9)
    return dict(zip(ids, labels)), score / len(X)


def describe_clusters(feats: dict[int, dict], labels: dict[int, int]) -> list[dict]:
    out = []
    for c in sorted(set(labels.values())):
        members = [feats[i] for i, lab in labels.items() if lab == c]
        avg = {name: sum(m[name] for m in members) / len(members) for name in ("pv", "buy_per_pv", "hesitation", "categories")}
        out.append({"cluster": c, "users": len(members), **{k: round(v, 3) for k, v in avg.items()},
                    "label": habit_label(avg)})
    return out


def habit_label(f: dict) -> str:
    if f["buy_per_pv"] >= 0.15:
        return "果断型"
    if f["hesitation"] >= 0.6 and f["buy_per_pv"] >= 0.01:
        return "比较型"
    if f.get("categories", 1 / max(f.get("focus", 1), 1e-9)) >= 5 and f["buy_per_pv"] < 0.02:
        return "闲逛型"
    return "比较型" if f["hesitation"] >= 0.5 else "随缘型"


HABITS = {"果断型": "看中了就下单，很少加购物车犹豫", "比较型": "会在同类商品之间反复比较，经常加入购物车后过几天才决定",
          "闲逛型": "逛得多买得少，很多时候只是随便看看", "随缘型": "没有固定的购物习惯"}


def render_persona(user: SimUser, segment: Segment | None, points: dict[int, SellingPoint], hidden_text: dict[str, str],
                   bystander: str) -> str:
    """人物描述由代码把字段渲染成文字，不让模型自由发挥：每句话都能追溯到一个结构化字段。"""
    habit = HABITS[habit_label(user.behavior)] + ("；对价格比较敏感" if user.price_sensitivity > 0.6 else "")
    if segment is None:
        return f"{bystander}\n你的购物习惯：{habit}。"
    motives = "；".join(points[i].text for i in segment.motives if i in points)
    lines = [f"你属于「{segment.name}」：{segment.scenario}", f"你最在意：{motives}。",
             f"你担心：{'；'.join(segment.concerns)}。"]
    if segment.avoid:
        lines.append(f"你不喜欢广告里强调：{'；'.join(segment.avoid)}。")
    lines += [hidden_text[h] for h in user.hidden if h in hidden_text]
    lines.append(f"你的购物习惯：{habit}。")
    return "\n".join(lines)


def build_pool(segments: list[Segment], points: list[SellingPoint], feats: dict[int, dict], config: dict) -> list[SimUser]:
    """按配置构造用户池。同一份配置和同一批人群定义，得到的用户池完全相同。"""
    rng = random.Random(config["seed"])
    by_id = {p.id: p for p in points}
    hidden_text = {h["name"]: h["persona"] for h in config["hidden"]}
    donors = sorted(feats)
    total = sum(s.size_share for s in segments) or 1.0
    users: list[SimUser] = []
    for uid in range(1, config["users"] + 1):
        if rng.random() < config["bystander_share"]:
            segment = None                                   # 路人：不属于任何目标人群，对所有素材反应都弱
        else:
            segment = rng.choices(segments, weights=[s.size_share / total for s in segments])[0]
        user = SimUser(
            id=uid, segment_id=segment.id if segment else None,
            behavior=dict(feats[rng.choice(donors)]),         # 行为特征：整组取自行为数据里的一个用户
            price_sensitivity=round(rng.random(), 3),         # 合成
            noise=round(rng.gauss(0, config["noise_sd"]), 3), # 合成
            hidden=[h["name"] for h in config["hidden"] if segment and rng.random() < h["share"]],
            holdout=rng.random() < config["holdout_share"])
        user.persona = render_persona(user, segment, by_id, hidden_text, config["bystander_persona"])
        users.append(user)
    return users


def scoring_view(user: SimUser) -> str:
    """打分时给模型看的人物描述：动机、顾虑、反感和隐藏属性。购物习惯那一行不给：
    它通过概率公式起作用（下单概率、价格敏感），和“素材是否相关”无关。
    描述相同的用户共用一次打分，这样一版素材只需要打几十次分，而不是每个用户一次。"""
    return user.persona.rsplit("\n你的购物习惯", 1)[0]
