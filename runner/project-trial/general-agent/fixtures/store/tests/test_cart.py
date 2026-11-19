import pytest

from store.cart import Cart
from store.catalog import demo_catalog


def test_add_and_subtotal():
    cart = Cart(demo_catalog())
    cart.add("tee", 2)
    cart.add("mug")
    assert cart.subtotal_cents() == 5990 * 2 + 3900


def test_add_same_sku_accumulates():
    cart = Cart(demo_catalog())
    cart.add("mug")
    cart.add("mug", 2)
    assert cart.lines == {"mug": 3}


def test_rejects_bad_input():
    cart = Cart(demo_catalog())
    with pytest.raises(ValueError):
        cart.add("mug", 0)
    with pytest.raises(KeyError):
        cart.add("nope")
