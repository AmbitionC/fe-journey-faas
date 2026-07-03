import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Query,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { InvestPoolService } from '../service/invest/pool';
import { InvestMarketService } from '../service/invest/market';
import { R } from '../common/base.error.utils';

/** 标的池与行情 API（只读）。 */
@Provide()
export class InvestPoolHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  poolService: InvestPoolService;

  @Inject()
  marketService: InvestMarketService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '标的池合并视图',
    functionName: 'investPool',
    name: 'investPool',
    path: '/invest/pool',
    method: 'get',
  })
  async pool(@Query(ALL) q: { date?: string }) {
    return { success: true, data: await this.poolService.pool(q.date) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '价格序列（OHLCV+MA20/60）',
    functionName: 'investPrice',
    name: 'investPrice',
    path: '/invest/price',
    method: 'get',
  })
  async price(@Query(ALL) q: { code: string; start?: string; end?: string; limit?: string }) {
    if (!q?.code) throw R.validateError('code 必填');
    return {
      success: true,
      data: await this.marketService.price(q.code, q.start, q.end, Number(q.limit) || 250),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'K线标记（计划动作/投顾信号）',
    functionName: 'investPriceMarks',
    name: 'investPriceMarks',
    path: '/invest/price/marks',
    method: 'get',
  })
  async marks(@Query(ALL) q: { code: string }) {
    if (!q?.code) throw R.validateError('code 必填');
    return { success: true, data: await this.marketService.marks(q.code) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '标的信息+估值财务（或 q 模糊搜索）',
    functionName: 'investStockInfo',
    name: 'investStockInfo',
    path: '/invest/stock/info',
    method: 'get',
  })
  async stockInfo(@Query(ALL) q: { code?: string; q?: string }) {
    if (!q?.code && !q?.q) throw R.validateError('code 或 q 必填其一');
    return { success: true, data: await this.marketService.stockInfo(q.code, q.q) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '资金与因子维度（北向持股/融资余额/因子暴露）',
    functionName: 'investStockExtras',
    name: 'investStockExtras',
    path: '/invest/stock/extras',
    method: 'get',
  })
  async stockExtras(@Query(ALL) q: { code: string; days?: string }) {
    if (!q?.code) throw R.validateError('code 必填');
    return {
      success: true,
      data: await this.marketService.extras(q.code, Number(q.days) || 120),
    };
  }
}
