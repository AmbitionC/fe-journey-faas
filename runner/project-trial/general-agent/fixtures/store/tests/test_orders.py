import pytest

from store.cart import Cart
from store.catalog import demo_catalog
from store.coupons import Coupon
from store.inventory import Inventory, OutOfStock
from store.orders import place_order


def make_cart(**lines):
    cart = Cart(demo_catalog())
    for sku, quantity in lines.items():
        cart.add(sku, quantity)
    return cart


def test_place_order_reserves_stock():
    inventory = Inventory({"tee": 5, "mug": 5})
    order = place_order(make_cart(tee=2, mug=1), inventory)
    assert order.subtotal_cents == 15880
    assert order.payable_yuan == 158.8
    assert inventory.available("tee") == 3


def test_place_order_with_member_and_coupon():
    inventory = Inventory({"bag": 5})
    coupon = Coupon("FULL200", threshold_cents=20000, off_cents=3000)
    order = place_order(make_cart(bag=2), inventory, member=True, coupon=coupon)
    assert order.payable_cents == 20220


def test_out_of_stock_releases_everything():
    inventory = Inventory({"tee": 5, "mug": 0})
    with pytest.raises(OutOfStock):
        place_order(make_cart(tee=2, mug=1), inventory)
    assert inventory.available("tee") == 5


def test_empty_cart():
    with pytest.raises(ValueError):
        place_order(make_cart(), Inventory({}))
