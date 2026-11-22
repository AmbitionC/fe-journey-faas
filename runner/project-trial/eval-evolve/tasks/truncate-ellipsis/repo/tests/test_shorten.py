from textkit.shorten import truncate


def test_short_text_untouched():
    assert truncate("你好", 10) == "你好"


def test_result_never_longer_than_limit():
    out = truncate("这是一条很长很长的商品标题", 8)
    assert len(out) == 8 and out.endswith("…")


def test_exact_length_untouched():
    assert truncate("12345", 5) == "12345"


def test_custom_suffix_counts_toward_limit():
    assert truncate("abcdefghij", 6, suffix="...") == "abc..."


def test_tiny_limit():
    assert truncate("abcdef", 1) == "…"
