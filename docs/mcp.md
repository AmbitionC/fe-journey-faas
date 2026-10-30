# 对外 MCP 数据服务

FC Web 函数 `fe-journey-main` 在 `server.js` 里把 `/mcp/*` 分流到 `src/mcp/http.ts`，不经 Midway。

| 端点 | 用途 |
|---|---|
| `POST /mcp/agent` | Agent Journey 工具：知识目录/检索/全文、面经、题卡、自测题 |
| `POST /mcp/invest` | Invest Journey 工具：市场读数快照、恐慌/乖离率/宏观序列、口径文档 |
| `GET /mcp/pricing` | 公开价目表（体验价 + 原价、每个工具扣几点） |
| `/mcp/me/*` | 自助后台（平台用户登录 token）：开通、建/吊销 Key、下单、我已支付、余额与流水 |
| `/mcp/admin/*` | 管理端（平台 admin 登录 token）：发内部 Key、订单确认/驳回、加减点、经营看板 |

协议：MCP Streamable HTTP 无状态模式（只回 `application/json`，GET → 405，通知 → 202）。
公开安装入口在两个 Skill 仓库：`AmbitionC/agent-journey-skills`、`AmbitionC/invest-journey-skills`。

## 鉴权与计费

- 请求头 `Authorization: Bearer jk_xxx`。表 `mcp_api_key` 只存 sha256，明文签发时返回一次。
- **自助 Key**（`user_id` 非空）：每次 `tools/call` 按 `TOOL_COST` 扣「Journey 点」，余额不足拒绝；
  工具失败自动退点。每日上限按档位（体验 200 / 入门 1000 / Pro 5000）。
- **内部 Key**（管理员手发，`user_id` 为空）：不扣点，只记日志 + 每日上限。
- 价目与档位真源：`src/mcp/billing.ts`（`SKUS` 的 `priceCents` 是体验价，`listCents` 是原价；
  恢复原价＝把 priceCents 改回 listCents）。新用户开通送 100 点。会员按月发点（年卡也是按月发 12 次，
  懒发放：用户下次调用或打开后台时补发），点数不过期。
- 收款：个人微信收款码 + 用户点「我已支付」+ 管理员确认到账后发货（`POST /mcp/admin/orders/confirm`）。
  设环境变量 `MCP_ORDER_AUTO_FULFILL=1` 可改为自报即发货（信任模式）。接商户号后用支付回调调 `fulfill` 即可。
- 表：`mcp_api_key`、`mcp_call_log`、`mcp_account`、`mcp_points_ledger`、`mcp_order`，
  首次请求时幂等自建（主库 synchronize=false），旧表缺的列查 information_schema 后补。
- 计费 SQL 测试对着真 MySQL 跑（`test/mcp.billing.test.ts`，CI 的 MySQL 服务；本地无库自动跳过）。

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
curl -s "$BASE/mcp/admin/orders?status=self_reported" -H "token: $TOKEN"   # 待确认到账
curl -s -X POST $BASE/mcp/admin/orders/confirm -H "token: $TOKEN" -d '{"orderNo":"MJ..."}'
curl -s -X POST $BASE/mcp/admin/orders/reject  -H "token: $TOKEN" -d '{"orderNo":"MJ...","note":"未收到款"}'
curl -s -X POST $BASE/mcp/admin/points/grant   -H "token: $TOKEN" -d '{"userId":"123","points":200,"note":"补偿"}'
curl -s "$BASE/mcp/admin/stats?days=30" -H "token: $TOKEN"       # 经营看板
```

管理后台（front-end-journey-manager）有对应页面，日常不用 curl。
