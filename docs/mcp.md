# 对外 MCP 数据服务（第一版·只读）

FC Web 函数 `fe-journey-main` 在 `server.js` 里把 `/mcp/*` 分流到 `src/mcp/http.ts`，不经 Midway。

| 端点 | 用途 |
|---|---|
| `POST /mcp/agent` | Agent Journey 工具：知识目录/检索/全文、面经、题卡、自测题 |
| `POST /mcp/invest` | Invest Journey 工具：市场读数快照、恐慌/乖离率/宏观序列、口径文档 |
| `/mcp/admin/*` | 管理端：发 Key、吊销、看用量（平台 admin 登录 token） |

协议：MCP Streamable HTTP 无状态模式（只回 `application/json`，GET → 405，通知 → 202）。
公开安装入口在两个 Skill 仓库：`AmbitionC/agent-journey-skills`、`AmbitionC/invest-journey-skills`。

## 鉴权与计量

- 请求头 `Authorization: Bearer jk_xxx`。表 `mcp_api_key` 只存 sha256，明文签发时返回一次。
- scope：`agent` / `invest` / `all`。
- 第一版不扣点：每次 `tools/call` 记 `mcp_call_log`，每 Key 每日上限（默认 2000，Redis 计数，北京时间日切）。
- 两张表首次请求时 `CREATE TABLE IF NOT EXISTS` 自建（主库 synchronize=false）。

## 安全边界（改工具时必须守住）

- Agent：只开 `knowledge` / `interview` 模块，付费课程 `firstclass` 不透出；自测题不含答案。
- Invest：只透出加工读数与口径。**不透出**买卖触发线、窗口状态、任何持仓/市值/成本、投顾个股信号。
  上游 service 返回管理端全量字段，投影白名单在 `src/mcp/tools/invest.ts`，`test/mcp.test.ts` 钉死。
- 口径文档 `src/mcp/methodology.ts` 不写内部提案/验证编号与买卖倍数。

## 管理端发 Key

```bash
BASE=https://fe-journey-main-ktantdfjcs.cn-hangzhou.fcapp.run
# token＝平台 admin 登录 token
curl -s -X POST $BASE/mcp/admin/keys -H "token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"scope":"invest","owner":"微信昵称或邮箱","note":"内测","dailyLimit":2000}'
curl -s $BASE/mcp/admin/keys -H "token: $TOKEN"                 # 列表
curl -s -X POST $BASE/mcp/admin/keys/revoke -H "token: $TOKEN" -d '{"id":3}'
curl -s "$BASE/mcp/admin/usage?days=7" -H "token: $TOKEN"        # 用量
```
