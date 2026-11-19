"""购物车。"""
from dataclasses import dataclass, field

from .catalog import Catalog


@dataclass
class Cart:
    catalog: Catalog
    lines: dict[str, int] = field(default_factory=dict)  # sku -> 数量

    def add(self, sku: str, quantity: int = 1) -> None:
        if quantity <= 0:
            raise ValueError("数量必须大于 0")
        self.catalog.get(sku)  # 不存在的商品在这里就报错
        self.lines[sku] = self.lines.get(sku, 0) + quantity

    def remove(self, sku: str) -> None:
        self.lines.pop(sku, None)

    def subtotal_cents(self) -> int:
        return sum(self.catalog.get(sku).price_cents * qty for sku, qty in self.lines.items())
