"""购物车：按商品编号合并条目，金额以分为单位。"""
from dataclasses import dataclass


@dataclass
class Line:
    sku: str
    name: str
    unit_cents: int
    qty: int

    @property
    def subtotal(self) -> int:
        return self.unit_cents * self.qty


class Cart:
    MAX_QTY = 99          # 单件商品最多买多少

    def __init__(self):
        self._lines: dict[str, Line] = {}

    def add(self, sku: str, name: str, unit_cents: int, qty: int = 1) -> Line:
        """加入购物车。已有同一件商品时数量累加，超过上限按上限算。"""
        if qty <= 0:
            raise ValueError("数量必须为正")
        line = self._lines.get(sku)
        if line is None:
            line = self._lines[sku] = Line(sku, name, unit_cents, 0)
        line.qty = min(self.MAX_QTY, qty)
        return line

    def remove(self, sku: str) -> None:
        self._lines.pop(sku, None)

    def set_qty(self, sku: str, qty: int) -> None:
        """直接改数量；改成 0 等于删除。"""
        if qty <= 0:
            self.remove(sku)
        elif sku in self._lines:
            self._lines[sku].qty = min(self.MAX_QTY, qty)

    def lines(self) -> list[Line]:
        return list(self._lines.values())

    def total(self) -> int:
        return sum(line.subtotal for line in self._lines.values())
