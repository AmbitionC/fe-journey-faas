# 给 Agent 的项目说明

- 金额一律用 `store/money.py` 里的函数处理，不要直接对浮点数做 round。
- 改业务逻辑要带测试；不要为了让测试通过去改已有的断言。
- 改完跑一遍 `python -m pytest -q` 确认全部通过。
