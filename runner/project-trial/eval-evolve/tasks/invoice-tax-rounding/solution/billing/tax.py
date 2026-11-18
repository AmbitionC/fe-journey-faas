from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


def tax_amount(net: float, rate: float) -> float:
    """税额，保留两位小数，四舍五入。"""
    return float((Decimal(str(net)) * Decimal(str(rate))).quantize(CENT, rounding=ROUND_HALF_UP))


def gross(net: float, rate: float) -> float:
    return float((Decimal(str(net)) + Decimal(str(tax_amount(net, rate)))).quantize(CENT, rounding=ROUND_HALF_UP))
