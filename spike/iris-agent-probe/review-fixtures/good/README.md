# 模型输出校验与自动修复

让大模型返回结构化 JSON 时，输出经常夹带 ```json 代码块、前后废话或缺字段。本项目：

- `src/parse.js`：从模型输出里提取第一个完整 JSON 对象（兼容代码块和前后文字）
- `src/validate.js`：按简单 schema 校验必填字段和类型，返回错误列表
- `src/retry.js`：校验失败时把错误反馈给模型重试，最多 3 次，仍失败返回 null
- `src/index.js`：接 OpenAI SDK 的入口

用 Cursor 写的，先让 AI 写了解析，发现它对代码块处理不对，补了用例后让它修。
