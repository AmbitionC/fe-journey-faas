# PDF 人工核实标记修复

基线为后端 master `bd0666de5943885bef6ba2050a4b3a18d401163b`，含 `a613288` 会员停售文案和 `bd0666d` 自报订单/访问路径导出。独立目录、分支 `codex/pdf-payment-verification-20261005`；仅本地，未推送、合并、部署或操作生产订单。

## 行为

- 用户点“我已支付”仍立即获得当前 Agent PDF 下载资格；新记录保持 `status=self_reported`、`bankVerified=false`。
- 同一账号、同一固定商品的 `self_reported` / `paid` 都可下载；人工核实与否不影响下载。重复点击不新建、不改原记录。
- 原有会员资格继续沿用；不改会员数据或历史订单状态。其他商品的旧 PDF 订单不冒充本商品资格。
- `refunded`、`cancelled`、`canceled`、`pending` 等状态不会因重报或核实恢复资格。
- 人工核实只更新 `bankVerified`、`bankVerifiedAt`、`bankVerifiedBy`，加订单行锁，重复操作幂等。取消核实只清该标记及核实人/时间，仍保留有效订单下载资格。核实人不暴露给普通用户的订单列表。

## 管理员接口

复用已有管理员认证，不新增凭据或权限；本轮仅提供后端接口，没有扩展管理站或未部署看板。

- `GET /materials/admin/purchases?take=50&skip=0`：分页资料订单，take 最大100，供核对实际收款。
- `POST /materials/admin/payment-verification`：JSON `{"orderNo":"实际订单号","bankVerified":true}`；false 用于纠正错误标记。操作者来自管理员登录身份；客户端身份、订单状态、金额字段不采信。
- 未人工确认时，没有任何路径自动认定真实到账。现有个人收款码仍无自动后端到账核验。

## 统计

`selfReported` 的 window/month 总数、金额和买家数继续包含全部自报记录，核实后仍保留；不再把它变成“未核实自报”。保留原 countedAsRevenue=false 兼容字段：这一自报总集不是核验流水，也不能作为另一份金额重复加总。

主 monthRevenue/monthOrderCount/分类汇总和日趋势按有效 PDF 自报及原有 paid 统计，不依赖 bankVerified。人工核实、取消核实都不增减主指标；历史未核实 paid 金额保留，不天然标为已核实。新增 monthRevenueBasis/revenueBasis=reported_or_legacy_paid 明确它们是经营声明口径，不能当成银行核验流水。

额外维度为 `manuallyVerifiedPdf`（人工核实子集）、`unverifiedSelfReportedPdf`（未核实自报子集）、`legacyPaidPdf`（未核实历史 paid 子集）。它们是主统计内的拆分，不能与主指标再相加。退款/取消排除于有效 PDF 主统计和人工核实子集；topPaths 及近期文案保留。归期仍按原订单 payTime。

管理页沿用 GET /growth/overview，新增只读 monthManuallyVerifiedPdf 聚合，明确 manual/PDF/subset；查询失败为 null，不伪造为零。原 netCashflow/breakeven 数值保留兼容，但新增 netCashflowBasis=reported_sales_minus_recorded_cost 说明它只是销售额减录入成本。管理页不再将它显示为真实现金流或“已打平”，真实净现金流显示待核对；当前没有完整到账和实付支出凭据。管理端独立补丁兼容旧接口/过渡版本，未知核实数据明确显示未知，没有新增管理员操作。

## 迁移与发布前条件

需要给 `order` 表增加三个字段，不改历史状态或权益。本地最终版本和独立过渡版本均明确设置 synchronize=false、dropSchema=false、migrationsRun=false；不依赖冷启动自动加列。**不能直接一次发布最终补丁**，必须按以下顺序协调：

1. 先仅部署外层交付目录 `schema-sync-guard.patch`（相对 bd0666d，原文也保存在仓库 scripts/migrations/20261005-schema-sync-guard.json）。它不注册新列，可在迁移前运行；保留 paid 下载兼容、自报主统计，作为后续唯一回退目标。
2. 确认所有能连接同一 order 表的旧运行源都退出或禁用：旧版本流量/别名、预留实例、触发器、回退包及长期进程不得再冷启动 synchronize=true。排空旧实例后核对实际版本。**仍运行的旧实例不会被本地新配置保护；无法证实此条件时，停止迁移与最终发布。** 当前生产状态未检查或更改，门禁仍未解除。
3. 用已有获准迁移渠道检查字段，确认缺失后显式执行下列 DDL（本轮未执行）；若三列已完整存在则不重复执行，若部分存在先核对实际结构。旧记录默认未核实，禁止按 paid 状态批量核实。
4. 确认三个字段存在后，再应用相对过渡版本的 `payment-verification-after-guard.patch` 发布完整功能。回退只能使用上述同步关闭的过渡版本，保留所有新增列；**禁止回退原 bd0666d 或任何 synchronize=true 版本**。

如果平台无法可靠禁用旧实例/旧冷启动来源，需要先完成额外保护，例如限制应用账号 ALTER/DROP。此类数据库权限调整不在本轮实施范围，须另外报批；本方案未新增账号、凭据或权限。生产清理、DDL、发布均留待父任务协调，不在本地执行。

```sql
ALTER TABLE `order`
  ADD COLUMN `bankVerified` tinyint(1) NOT NULL DEFAULT 0 COMMENT '人工核实到账；不作为资料下载门槛',
  ADD COLUMN `bankVerifiedAt` datetime NULL COMMENT '人工核实到账时间',
  ADD COLUMN `bankVerifiedBy` varchar(128) NULL COMMENT '执行人工核实的管理员标识';
```

该 SQL 只增加列，不删除或改写订单/会员。过渡补丁和后续补丁是两个独立交付，生产迁移门禁记录位于本次交付目录 deployment-gates.json，当前仍为未通过。

## 本地验证

定向命令：

```sh
NODE_ENV=unittest node --no-experimental-strip-types node_modules/mocha/bin/mocha.js --no-config --require ts-node/register test/pdfSelfReport.test.ts test/pdfPaymentVerification.test.ts test/pdfPaymentStatistics.test.ts test/pdfSchemaGuard.test.ts test/commercePause.test.ts test/legacyPdfGift.test.ts test/auxPurpose.test.ts
```

62条通过，2条既有原版 PDF 文件用例因未设置 LEGACY_PDF_TEST_PATH 跳过。新增审核反例断言：9.9 自报、19.9 历史 paid 在核实/取消核实前后主金额、自报总量和趋势不变；历史 paid 不自动进入核实子集。真实 TypeORM 冷启动/回退生命周期使用旧实体元数据，驱动 I/O 全部替换，确认不会调用任何同步/删库/自动迁移。统计 SQL 仅在 SQLite 内存库执行；不连接生产。下载、幂等、鉴权、跨用户、退款取消回归保留。

管理端7项 React 服务端渲染/页面接入测试通过，覆盖销售声明、人工核实 PDF 子集、旧接口缺数据、查询失败、明确零值、忽略派生净现金流/已打平和真实页面接入；没有浏览器或生产 UI 验收。

最终版本6个生产改动文件及其导入、过渡版本3个文件分别通过定向 TypeScript 检查；两阶段补丁应用检查及 git diff --check 通过。未开浏览器、未跑大型构建、未碰资源仓库。生产旧实例清退与 DDL 条件尚待协调验收。
