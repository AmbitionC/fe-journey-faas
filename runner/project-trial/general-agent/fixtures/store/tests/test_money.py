from store.money import percent_of, to_cents, to_yuan


def test_to_cents_plain():
    assert to_cents(59.9) == 5990
    assert to_cents(39) == 3900


def test_to_cents_rounds_half_up():
    # 业务规则 1：2.675 元记为 2.68 元
    assert to_cents(2.675) == 268
    assert to_cents(1.005) == 101


def test_percent_of_rounds_half_up():
    # 5 分打九折是 4.5 分，四舍五入记为 5 分
    assert percent_of(5, 90) == 5
    assert percent_of(1999, 90) == 1799


def test_to_yuan():
    assert to_yuan(268) == 2.68
