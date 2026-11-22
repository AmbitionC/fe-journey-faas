from collections import OrderedDict


class LRUCache:
    """容量固定的缓存：放满之后淘汰最久没有被用到的那一项。读取也算用到。"""

    def __init__(self, capacity: int):
        self.capacity = capacity
        self._data: OrderedDict[str, object] = OrderedDict()

    def get(self, key: str, default=None):
        return self._data.get(key, default)

    def put(self, key: str, value: object) -> None:
        self._data[key] = value
        if len(self._data) > self.capacity:
            self._data.popitem(last=False)

    def keys(self) -> list[str]:
        return list(self._data)
