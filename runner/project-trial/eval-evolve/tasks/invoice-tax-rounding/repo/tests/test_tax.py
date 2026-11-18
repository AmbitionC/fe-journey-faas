from billing.tax import gross, tax_amount


def test_plain():
    assert tax_amount(100.0, 0.13) == 13.0


def test_half_cent_rounds_up():
    # 8.5 × 0.13 = 1.105，应记为 1.11
    assert tax_amount(8.5, 0.13) == 1.11
    # 12.5 × 0.13 = 1.625，应记为 1.63
    assert tax_amount(12.5, 0.13) == 1.63


def test_gross():
    assert gross(8.5, 0.13) == 9.61
