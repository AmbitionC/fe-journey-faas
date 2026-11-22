def apply_coupon(total_cents: int, percent_off: int, max_off_cents: int | None = None) -> int:
    """按百分比打折，返回折后金额（分）。优惠金额四舍五入到分；有封顶时优惠不超过封顶。"""
    off = total_cents * percent_off // 100
    if max_off_cents is not None:
        off = max(off, max_off_cents)
    return total_cents - off
