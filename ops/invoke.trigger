daily_update_plan
# 手动触发#3：FaaS已于15:51Z(PR#8)部署resilient代码——数据更新失败不再中止整job，
# 仍落库账户快照/恐慌、仅跳过出计划。即便旧invoke(14:53Z)仍占Tushare导致本次update
# ip超限，账户快照也会按库内收盘×持仓写入最新交易日，把总资产从7/3解卡。
