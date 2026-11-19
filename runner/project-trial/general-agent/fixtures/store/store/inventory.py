"""库存：下单时先预占，支付成功后扣减，订单取消时释放。"""


class OutOfStock(Exception):
    pass


class Inventory:
    def __init__(self, stock: dict[str, int]) -> None:
        self.stock = dict(stock)                      # 仓库里实际有多少
        self.reserved = {sku: 0 for sku in stock}     # 已被未支付订单占住多少

    def available(self, sku: str) -> int:
        """现在还能卖多少。"""
        return self.stock.get(sku, 0) - self.reserved.get(sku, 0)

    def reserve(self, sku: str, quantity: int) -> None:
        """预占库存。数量不够时抛 OutOfStock。"""
        if self.stock.get(sku, 0) < quantity:
            raise OutOfStock(f"{sku} 库存不足")
        self.reserved[sku] = self.reserved.get(sku, 0) + quantity

    def release(self, sku: str, quantity: int) -> None:
        """释放预占（订单取消或下单失败）。"""
        self.reserved[sku] = max(0, self.reserved.get(sku, 0) - quantity)

    def commit(self, sku: str, quantity: int) -> None:
        """支付成功：把预占的数量真正扣掉。"""
        self.reserved[sku] -= quantity
        self.stock[sku] -= quantity
