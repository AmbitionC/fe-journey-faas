def backoff_delays(attempts: int, base: float = 1.0, cap: float = 30.0) -> list[float]:
    """第 n 次重试前等多久：base * 2^n，不超过 cap。"""
    return [base * 2 ** n for n in range(attempts)]
