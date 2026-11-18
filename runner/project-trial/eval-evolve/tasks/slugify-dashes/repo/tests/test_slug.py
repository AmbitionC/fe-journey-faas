from textkit.slug import slugify


def test_simple():
    assert slugify("Hello World") == "hello-world"


def test_repeated_separators_collapse():
    assert slugify("Hello,   World") == "hello-world"


def test_no_leading_or_trailing_dash():
    assert slugify("  Hello World!  ") == "hello-world"
