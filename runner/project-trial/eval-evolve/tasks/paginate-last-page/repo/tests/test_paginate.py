from listing.paginate import page_count, page_slice


def test_exact_division():
    assert page_count(20, 10) == 2


def test_remainder_needs_one_more_page():
    assert page_count(21, 10) == 3


def test_empty_has_no_pages():
    assert page_count(0, 10) == 0


def test_last_page_slice():
    assert page_slice(list(range(21)), 3, 10) == [20]
