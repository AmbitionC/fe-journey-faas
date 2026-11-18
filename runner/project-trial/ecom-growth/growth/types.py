"""各环节之间流转的数据。环节之间只交换编号和这些结构，不互相塞大段文字。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

CLAIM_LEVELS = ("verified", "needs_proof", "forbidden")
ANGLES = ("痛点", "场景", "成分", "对比", "口碑")
TONES = ("理性", "亲切", "俏皮")


@dataclass
class Product:
    id: int
    name: str
    category: str
    detail: str                       # 商品详情原文
    specs: dict[str, str]             # 规格与成分表
    reviews: list[str]                # 用户评价原文
    proofs: list[str] = field(default_factory=list)       # 商家已有资质或检测报告支持的声明（人确认用）
    competitors: list[str] = field(default_factory=list)  # 竞品名单，审核规则引用

    @property
    def corpus(self) -> str:
        return "\n".join([self.detail, *[f"{k}：{v}" for k, v in self.specs.items()], *self.reviews])


@dataclass
class SellingPoint:
    id: int
    text: str                         # 卖点本身，如“不含酒精”
    category: str                     # 功效 / 成分 / 使用感 / 规格 / 价格 / 服务
    evidence: str                     # 原文依据，逐字摘自详情、规格或评价
    source: str                       # detail | review | spec
    claim_level: str                  # verified | needs_proof | forbidden
    review_support: int = 0           # 有多少条评价提到了它
    confirmed: bool = False           # needs_proof 的卖点经人确认有依据后为真
    keywords: list[str] = field(default_factory=list)   # 评价里提到它时常用的词，用来数提及次数

    @property
    def usable(self) -> bool:
        return self.claim_level == "verified" or (self.claim_level == "needs_proof" and self.confirmed)


@dataclass
class Segment:
    id: int
    name: str
    scenario: str
    motives: list[int]                # 卖点编号
    concerns: list[str]
    avoid: list[str]
    review_quotes: list[str]          # 支持这类人群存在的评价原话
    size_share: float = 0.25


@dataclass
class Creative:
    id: int
    segment_id: int
    selling_point_ids: list[int]
    angle: str
    tone: str
    body: str
    format: str = "short_copy"
    parent_id: int | None = None
    round: int = 1
    status: str = "draft"             # draft | approved | rejected | retired
    review: dict = field(default_factory=dict)
    note: str = ""                    # 改写时：依据哪条结论、改了哪一项


@dataclass
class SimUser:
    id: int
    segment_id: int | None            # None 表示不属于任何目标人群的路人
    behavior: dict                    # 行为特征，抽样自行为数据
    price_sensitivity: float          # 合成，0 到 1
    noise: float                      # 合成，点击意愿的固定随机偏移
    hidden: list[str]                 # 隐藏属性：素材生成环节不知道
    holdout: bool = False             # 留出用户：试投和归因从不使用，只在最后验收
    persona: str = ""


@dataclass
class Relevance:
    motive: int                       # 0~2：是否说中在意的点
    concern: int                      # 0~2：是否回应了顾虑
    aversion: int                     # 0~2：是否有反感的说法
    feedback: str = ""


@dataclass
class Impression:
    round: int
    creative_id: int
    segment_id: int | None
    user_id: int
    clicked: bool
    ordered: bool
    feedback: str = ""


@dataclass
class Finding:
    segment_id: int
    kind: str                         # works | fails | unaddressed | inconclusive
    statement: str
    support: dict = field(default_factory=dict)
    confidence: str = "low"           # high | medium | low
    quotes: list[str] = field(default_factory=list)


@dataclass
class Reaction:
    clicked: bool
    ordered: bool
    feedback: str = ""


class TextModel(Protocol):
    """各环节用的模型接口：一段系统提示、一段输入，返回文本。

    data 是拼出这段输入所用的结构化数据。真模型不看它；离线替身（growth/offline.py）直接读它，
    省得从提示词里反解析。
    """
    async def ask(self, system: str, user: str, *, data: dict | None = None) -> str: ...
