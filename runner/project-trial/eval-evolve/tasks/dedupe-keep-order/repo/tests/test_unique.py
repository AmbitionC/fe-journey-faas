from seqkit.unique import unique


def test_removes_duplicates():
    assert unique([1, 1, 2]) == [1, 2]


def test_keeps_first_seen_order():
    assert unique(["b", "a", "b", "c", "a"]) == ["b", "a", "c"]
