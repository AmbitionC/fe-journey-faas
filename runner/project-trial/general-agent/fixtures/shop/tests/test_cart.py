from shop.cart import cart_total, line_total


def test_line_total():
    assert line_total(19.9, 3) == 59.7


def test_half_cent_rounds_up():
    # 2.675 元的商品买 1 件，应按四舍五入记为 2.68
    assert line_total(2.675, 1) == 2.68


def test_discount_rounding():
    items = [{"price": 0.15, "quantity": 1}, {"price": 0.15, "quantity": 1}, {"price": 0.15, "quantity": 1}]
    # 0.45 打九折是 0.405，应记为 0.41
    assert cart_total(items, discount=0.1) == 0.41
