def tax_amount(net: float, rate: float) -> float:
    """税额，保留两位小数，四舍五入。"""
    return round(net * rate, 2)


def gross(net: float, rate: float) -> float:
    return round(net + tax_amount(net, rate), 2)
