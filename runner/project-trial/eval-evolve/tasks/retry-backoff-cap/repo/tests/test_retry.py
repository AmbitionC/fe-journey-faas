from netkit.retry import backoff_delays


def test_grows_exponentially():
    assert backoff_delays(3) == [1.0, 2.0, 4.0]


def test_capped():
    assert backoff_delays(7) == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0]


def test_custom_cap():
    assert max(backoff_delays(10, base=0.5, cap=5.0)) == 5.0
