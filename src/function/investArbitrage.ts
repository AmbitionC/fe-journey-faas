import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Query,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { InvestArbitrageService } from '../service/invest/arbitrage';

/** 套利模块 API（只读）：统一资金账本 / carry / 盲区α / 三水表 / 记分卡。 */
@Provide()
export class InvestArbitrageHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  arbService: InvestArbitrageService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '统一资金账本（sleeve 分配 + 零杠杆状态）',
    functionName: 'investArbLedger',
    name: 'investArbLedger',
    path: '/invest/arbitrage/ledger',
    method: 'get',
  })
  async ledger(@Query(ALL) q: { date?: string }) {
    return { success: true, data: await this.arbService.ledger(q.date) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'carry 信号（逆回购/红利/可转债）',
    functionName: 'investArbCarry',
    name: 'investArbCarry',
    path: '/invest/arbitrage/carry',
    method: 'get',
  })
  async carry(@Query(ALL) q: { date?: string; sleeve?: string }) {
    return { success: true, data: await this.arbService.carry(q) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '盲区 α 候选（带证伪状态）',
    functionName: 'investArbAlpha',
    name: 'investArbAlpha',
    path: '/invest/arbitrage/alpha',
    method: 'get',
  })
  async alpha(@Query(ALL) q: { date?: string }) {
    return { success: true, data: await this.arbService.alpha(q.date) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '三水表资金流分',
    functionName: 'investArbFlow',
    name: 'investArbFlow',
    path: '/invest/arbitrage/flow',
    method: 'get',
  })
  async flow(@Query(ALL) q: { date?: string }) {
    return { success: true, data: await this.arbService.flow(q.date) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '套利战绩记分卡',
    functionName: 'investArbScorecard',
    name: 'investArbScorecard',
    path: '/invest/arbitrage/scorecard',
    method: 'get',
  })
  async scorecard() {
    return { success: true, data: await this.arbService.scorecard() };
  }
}
