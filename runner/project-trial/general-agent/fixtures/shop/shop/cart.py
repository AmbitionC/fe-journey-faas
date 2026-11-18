from decimal import Decimal


def line_total(price: float, quantity: int) -> float:
    """一行商品的小计，保留两位小数。"""
    return round(price * quantity, 2)


def cart_total(items: list[dict], discount: float = 0.0) -> float:
    """购物车总价。discount 是折扣比例，0.1 表示打九折。"""
    subtotal = sum(line_total(i["price"], i["quantity"]) for i in items)
    return round(subtotal * (1 - discount), 2)
