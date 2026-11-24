from relkit.versions import is_newer, latest, parse


def test_parse():
    assert parse("v1.10.0") == (1, 10, 0)


def test_two_digit_minor_is_newer():
    assert is_newer("1.10.0", "1.9.3")
    assert not is_newer("1.9.3", "1.10.0")


def test_same_version_is_not_newer():
    assert not is_newer("v2.0.0", "2.0.0")


def test_latest_picks_highest_number():
    assert latest(["1.2.0", "1.10.1", "1.9.9"]) == "1.10.1"
