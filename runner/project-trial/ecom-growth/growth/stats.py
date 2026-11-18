"""Beta 分布相关的几个小工具：区间、谁更好的概率、谁是最优的概率。只用标准库。"""
from __future__ import annotations

import math
import random


def _betacf(a: float, b: float, x: float) -> float:
    """不完全 Beta 函数的连分式展开（Lentz 方法）。"""
    tiny, qab, qap, qam = 1e-30, a + b, a + 1, a - 1
    c, d = 1.0, 1 - qab * x / qap
    d = 1 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 300):
        m2 = 2 * m
        for aa in (m * (b - m) * x / ((qam + m2) * (a + m2)), -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))):
            d = 1 + aa * d
            d = 1 / (d if abs(d) > tiny else tiny)
            c = 1 + aa / c
            c = c if abs(c) > tiny else tiny
            delta = d * c
            h *= delta
        if abs(delta - 1) < 1e-12:
            break
    return h


def beta_cdf(x: float, a: float, b: float) -> float:
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    front = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x))
    if x < (a + 1) / (a + b + 2):
        return front * _betacf(a, b, x) / a
    return 1 - front * _betacf(b, a, 1 - x) / b


def beta_ppf(q: float, a: float, b: float) -> float:
    lo, hi = 0.0, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if beta_cdf(mid, a, b) < q:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def interval(successes: int, n: int, level: float = 0.9) -> tuple[float, float]:
    """用 Beta(1+成功, 1+失败) 的分位数给出区间。样本少时区间自然很宽。"""
    a, b, tail = 1 + successes, 1 + n - successes, (1 - level) / 2
    return beta_ppf(tail, a, b), beta_ppf(1 - tail, a, b)


def prob_greater(x: tuple[float, float], y: tuple[float, float], rng: random.Random, n: int = 4000) -> float:
    """从两个 Beta 分布里成对抽样，x 更高的比例。区间重叠不等于没有差别，严格的比较看这个数。"""
    return sum(rng.betavariate(*x) > rng.betavariate(*y) for _ in range(n)) / n


def prob_best(stats: dict, rng: random.Random, n: int = 4000) -> dict:
    """每个选项“确实是最优”的概率。"""
    keys = list(stats)
    if not keys:
        return {}
    wins = dict.fromkeys(keys, 0)
    for _ in range(n):
        wins[max(keys, key=lambda k: rng.betavariate(*stats[k]))] += 1
    return {k: wins[k] / n for k in keys}


def lift_interval(new: tuple[int, int], old: tuple[int, int], rng: random.Random, n: int = 4000,
                  level: float = 0.9) -> tuple[float, float, float]:
    """新旧两版的相对提升（新/旧 - 1）及区间。入参是（成功数, 曝光数）。"""
    draws = sorted(rng.betavariate(1 + new[0], 1 + new[1] - new[0])
                   / max(rng.betavariate(1 + old[0], 1 + old[1] - old[0]), 1e-9) - 1 for _ in range(n))
    tail = (1 - level) / 2
    return draws[n // 2], draws[int(n * tail)], draws[int(n * (1 - tail)) - 1]


def bigrams(text: str) -> set[str]:
    t = "".join(ch for ch in text if ch.isalnum())
    return {t[i:i + 2] for i in range(len(t) - 1)} or {t}


def similarity(a: str, b: str) -> float:
    """两段文字的相似度：字符二元组的 Jaccard。不依赖向量模型，够用来拦“几乎一样”的素材。"""
    x, y = bigrams(a), bigrams(b)
    return len(x & y) / max(len(x | y), 1)
