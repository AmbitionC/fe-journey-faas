"""下单：算钱、预占库存、生成订单。"""
from dataclasses import dataclass

from .cart import Cart
from .coupons import Coupon, apply_discounts
from .inventory import Inventory, OutOfStock
from .money import to_yuan


@dataclass(frozen=True)
class Order:
    lines: dict[str, int]
    subtotal_cents: int
    payable_cents: int

    @property
    def payable_yuan(self) -> float:
        return to_yuan(self.payable_cents)


def place_order(cart: Cart, inventory: Inventory, member: bool = False,
                coupon: Coupon | None = None) -> Order:
    """把购物车变成订单。任何一件商品库存不够，整单失败，已经预占的全部释放。"""
    if not cart.lines:
        raise ValueError("购物车是空的")
    done: list[tuple[str, int]] = []
    try:
        for sku, quantity in cart.lines.items():
            inventory.reserve(sku, quantity)
            done.append((sku, quantity))
    except OutOfStock:
        for sku, quantity in done:
            inventory.release(sku, quantity)
        raise
    subtotal = cart.subtotal_cents()
    return Order(dict(cart.lines), subtotal, apply_discounts(subtotal, member, coupon))
