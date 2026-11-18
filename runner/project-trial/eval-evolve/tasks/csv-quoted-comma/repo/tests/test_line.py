from tabular.line import parse_line


def test_plain():
    assert parse_line("a, b, c") == ["a", "b", "c"]


def test_quoted_field_keeps_comma():
    assert parse_line('1, "Smith, John", 30') == ["1", "Smith, John", "30"]


def test_empty_fields():
    assert parse_line("a,,c") == ["a", "", "c"]
