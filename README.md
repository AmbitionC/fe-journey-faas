# fe-journey-faas

阿里云 FC 3.0 上的两组互相独立的函数，push master 自动部署（.github/workflows/deploy.yml）。

## fe-journey Web 函数（fcJourneyMain）
Midway 应用整体跑成单个 FC3 Web 函数（server.js，支持 SSE 流式）。

## invest-model 定时函数（investLiveWatch / investScheduler）
A 股盯盘/复盘等定时任务，代码来自 AmbitionC/invest-model 仓库（部署时 checkout 打包）：
- invest-live-watch：交易时段每 3 分钟盯盘扫描
- invest-scheduler：快照提醒(15:20) / ETF入库(16:50) / 盘后更新+计划(17:00) / 周六重建+复盘(18:00)

手动触发某个 job：Actions → 「Invoke invest job (manual)」→ Run workflow，
或改 `ops/invoke.trigger` 第一行为 job 名后 push master。

注意：`INVEST_GH_PAT` 必须是「机器人小号」的 classic PAT（评论作者若是本人，
GitHub 不会给本人发通知邮件）；更换 secret 后需重新部署才生效。

> `INVEST_GH_PAT` 当前为机器人小号 token（2026-07-03 更换）。

> 2026-07-03: 推送评论统一追加 @提及（邮件不依赖 Watch 级别）。

> 2026-07-09: 重新部署以纳入 invest-model P0 修复（PR #46：白名单硬止损豁免、
> 停牌/转债重估口径、计划现金源等）——盯盘与盘后任务打包 master 最新代码。
