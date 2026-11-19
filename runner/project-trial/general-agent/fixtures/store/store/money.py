"""金额：内部统一用“分”（整数）计算，只有进出口才和“元”互相转换。"""


def to_cents(yuan: float) -> int:
    """元转成分，四舍五入到分。"""
    return int(round(yuan * 100))


def to_yuan(cents: int) -> float:
    return cents / 100


def percent_of(cents: int, percent: int) -> int:
    """按百分比取金额，比如 percent_of(1999, 90) 是打九折。结果四舍五入到分。"""
    return int(round(cents * percent / 100))
