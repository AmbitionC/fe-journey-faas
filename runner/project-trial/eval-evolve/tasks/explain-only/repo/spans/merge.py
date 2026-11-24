def merge_intervals(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """合并有重叠或首尾相接的区间，返回按起点排序的结果。"""
    merged: list[tuple[int, int]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged
