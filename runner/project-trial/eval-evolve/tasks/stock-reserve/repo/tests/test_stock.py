import pytest

from warehouse.stock import OutOfStock, Stock


def test_reserve_within_stock():
    s = Stock()
    s.receive("A", 5)
    s.reserve("A", 3)
    assert s.available("A") == 2


def test_second_order_cannot_take_what_is_already_reserved():
    s = Stock()
    s.receive("A", 5)
    s.reserve("A", 4)
    with pytest.raises(OutOfStock):
        s.reserve("A", 3)
    assert s.available("A") == 1


def test_release_then_reserve_again():
    s = Stock()
    s.receive("A", 2)
    s.reserve("A", 2)
    s.release("A", 2)
    s.reserve("A", 2)
    assert s.available("A") == 0


def test_ship_reduces_both():
    s = Stock()
    s.receive("A", 5)
    s.reserve("A", 2)
    s.ship("A", 2)
    assert s.available("A") == 3
