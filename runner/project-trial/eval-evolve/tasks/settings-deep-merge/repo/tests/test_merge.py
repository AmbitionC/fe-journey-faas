from settings.merge import merge


def test_flat():
    assert merge({"a": 1}, {"b": 2}) == {"a": 1, "b": 2}


def test_nested_keys_are_merged():
    base = {"db": {"host": "localhost", "port": 5432}}
    assert merge(base, {"db": {"port": 6543}}) == {"db": {"host": "localhost", "port": 6543}}


def test_inputs_untouched():
    base = {"db": {"host": "localhost"}}
    merge(base, {"db": {"host": "example"}})
    assert base == {"db": {"host": "localhost"}}
