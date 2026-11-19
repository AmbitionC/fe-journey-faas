"""商品目录。"""
from dataclasses import dataclass

from .money import to_cents


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price_cents: int


class Catalog:
    def __init__(self) -> None:
        self._products: dict[str, Product] = {}

    def add(self, sku: str, name: str, price_yuan: float) -> Product:
        product = Product(sku, name, to_cents(price_yuan))
        self._products[sku] = product
        return product

    def get(self, sku: str) -> Product:
        if sku not in self._products:
            raise KeyError(f"没有这个商品：{sku}")
        return self._products[sku]


def demo_catalog() -> Catalog:
    catalog = Catalog()
    catalog.add("tee", "纯棉短袖", 59.9)
    catalog.add("mug", "马克杯", 39.0)
    catalog.add("bag", "帆布包", 129.0)
    catalog.add("pen", "中性笔", 2.675)
    return catalog
