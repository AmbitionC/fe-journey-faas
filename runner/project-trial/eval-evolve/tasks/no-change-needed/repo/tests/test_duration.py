import pytest

from timekit.duration import parse_duration


def test_single_unit():
    assert parse_duration("45s") == 45 and parse_duration("2d") == 172800


def test_combined():
    assert parse_duration("1h30m") == 5400


def test_case_and_spaces():
    assert parse_duration(" 2H ") == 7200


def test_invalid():
    with pytest.raises(ValueError):
        parse_duration("soon")
