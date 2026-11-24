from cachekit.lru import LRUCache


def test_evicts_oldest_when_full():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2); c.put("c", 3)
    assert c.get("a") is None and c.get("b") == 2 and c.get("c") == 3


def test_read_keeps_entry_alive():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    assert c.get("a") == 1
    c.put("c", 3)
    assert c.get("a") == 1 and c.get("b") is None


def test_overwrite_refreshes_entry():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2); c.put("a", 10); c.put("c", 3)
    assert c.get("a") == 10 and c.get("b") is None


def test_missing_key_returns_default():
    assert LRUCache(1).get("x", "none") == "none"
