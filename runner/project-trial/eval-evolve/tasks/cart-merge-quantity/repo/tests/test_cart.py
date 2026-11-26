from shop.cart import Cart


def test_add_new_item():
    c = Cart()
    c.add("tea", "乌龙茶", 1500, 2)
    assert c.total() == 3000


def test_adding_same_item_accumulates():
    c = Cart()
    c.add("tea", "乌龙茶", 1500, 2)
    c.add("tea", "乌龙茶", 1500, 3)
    assert [(l.sku, l.qty) for l in c.lines()] == [("tea", 5)]
    assert c.total() == 7500


def test_quantity_is_capped():
    c = Cart()
    c.add("tea", "乌龙茶", 1500, 60)
    c.add("tea", "乌龙茶", 1500, 60)
    assert c.lines()[0].qty == 99


def test_set_qty_zero_removes():
    c = Cart()
    c.add("tea", "乌龙茶", 1500)
    c.set_qty("tea", 0)
    assert c.lines() == []
