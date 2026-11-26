"""库存：实际数量和已被订单预占的数量分开记。"""


class OutOfStock(Exception):
    pass


class Stock:
    def __init__(self):
        self._on_hand: dict[str, int] = {}
        self._reserved: dict[str, int] = {}

    def receive(self, sku: str, qty: int) -> None:
        if qty <= 0:
            raise ValueError("入库数量必须为正")
        self._on_hand[sku] = self._on_hand.get(sku, 0) + qty

    def available(self, sku: str) -> int:
        return self._on_hand.get(sku, 0) - self._reserved.get(sku, 0)

    def reserve(self, sku: str, qty: int) -> None:
        """给一张订单预占库存。可用数量不够时抛 OutOfStock，不做部分预占。"""
        if qty <= 0:
            raise ValueError("预占数量必须为正")
        if qty > self._on_hand.get(sku, 0):
            raise OutOfStock(sku)
        self._reserved[sku] = self._reserved.get(sku, 0) + qty

    def release(self, sku: str, qty: int) -> None:
        """订单取消：把预占还回去，最多还到 0。"""
        self._reserved[sku] = max(0, self._reserved.get(sku, 0) - qty)

    def ship(self, sku: str, qty: int) -> None:
        """发货：实际库存和预占同时扣掉。"""
        if qty > self._reserved.get(sku, 0):
            raise ValueError("发货数量超过了预占数量")
        self._on_hand[sku] -= qty
        self._reserved[sku] -= qty
