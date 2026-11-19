from store.coupons import Coupon, apply_discounts

FULL_200_MINUS_30 = Coupon("FULL200", threshold_cents=20000, off_cents=3000)


def test_no_discount():
    assert apply_discounts(12900) == 12900


def test_member_only():
    assert apply_discounts(12900, member=True) == 11610


def test_coupon_only():
    assert apply_discounts(25800, coupon=FULL_200_MINUS_30) == 22800
    assert apply_discounts(19900, coupon=FULL_200_MINUS_30) == 19900  # 没到门槛，不减


def test_member_then_coupon():
    # 业务规则 2：先打九折 258 → 232.2，再满 200 减 30 → 202.2
    assert apply_discounts(25800, member=True, coupon=FULL_200_MINUS_30) == 20220


def test_threshold_uses_discounted_amount():
    # 210 元打九折是 189 元，没到 200 的门槛，满减券不能用
    assert apply_discounts(21000, member=True, coupon=FULL_200_MINUS_30) == 18900


def test_coupon_never_goes_below_zero():
    assert apply_discounts(500, coupon=Coupon("BIG", threshold_cents=0, off_cents=3000)) == 0
