from promo.coupon import apply_coupon


def test_plain_percent():
    assert apply_coupon(10000, 20) == 8000


def test_discount_rounds_half_up():
    # 1999 分打 15%：优惠 299.85 分，四舍五入为 300 分
    assert apply_coupon(1999, 15) == 1699


def test_cap_limits_discount():
    assert apply_coupon(100000, 30, max_off_cents=5000) == 95000


def test_cap_not_reached():
    assert apply_coupon(1000, 10, max_off_cents=5000) == 900
