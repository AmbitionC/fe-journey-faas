"""优惠：会员折扣和满减券。规则见 README 的“业务规则”。"""
from dataclasses import dataclass

from .money import percent_of

MEMBER_PERCENT = 90  # 会员九折


@dataclass(frozen=True)
class Coupon:
    """满减券：满 threshold_cents 减 off_cents。"""
    code: str
    threshold_cents: int
    off_cents: int


def apply_discounts(subtotal_cents: int, member: bool = False, coupon: Coupon | None = None) -> int:
    """算出优惠后的应付金额（分）。"""
    total = subtotal_cents
    if coupon is not None and total >= coupon.threshold_cents:
        total = max(0, total - coupon.off_cents)
    if member:
        total = percent_of(total, MEMBER_PERCENT)
    return total
