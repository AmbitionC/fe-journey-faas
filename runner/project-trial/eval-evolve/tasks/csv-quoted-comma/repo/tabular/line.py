def parse_line(line: str) -> list[str]:
    """把一行 CSV 拆成字段。字段可以用双引号包起来，引号里允许出现逗号。"""
    return [field.strip() for field in line.split(",")]
