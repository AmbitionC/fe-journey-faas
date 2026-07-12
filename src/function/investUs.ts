import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Query,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { InvestUsService } from '../service/invest/us';
import { assertAdmin } from '../common/admin.guard';
import { R } from '../common/base.error.utils';

/**
 * 美股模块 API（/invest/us/*）：读=登录即可；持仓写=管理员。
 * 与 A 股函数零交集（独立文件，us_* 表）。
 */
@Provide()
export class InvestUsHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  usService: InvestUsService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '美股总览',
    functionName: 'investUsOverview',
    name: 'investUsOverview',
    path: '/invest/us/overview',
    method: 'get',
  })
  async overview() {
    return { success: true, data: await this.usService.overview() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '美股计划日期列表',
    functionName: 'investUsPlanDates',
    name: 'investUsPlanDates',
    path: '/invest/us/plan/dates',
    method: 'get',
  })
  async planDates() {
    return { success: true, data: await this.usService.planDates() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '美股按日计划（三层结构+期权候选）',
    functionName: 'investUsPlan',
    name: 'investUsPlan',
    path: '/invest/us/plan',
    method: 'get',
  })
  async plan(@Query('date') date?: string) {
    return { success: true, data: await this.usService.plan(date) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '美股当前持仓',
    functionName: 'investUsHoldings',
    name: 'investUsHoldings',
    path: '/invest/us/holdings',
    method: 'get',
  })
  async holdings() {
    return { success: true, data: await this.usService.holdings() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '美股持仓新增/编辑',
    functionName: 'investUsHoldingsSave',
    name: 'investUsHoldingsSave',
    path: '/invest/us/holdings',
    method: 'post',
  })
  async saveHolding(
    @Body(ALL) body: {
      code: string; shares: number; cost_price: number; sleeve?: string; entry_date?: string;
    }
  ) {
    await assertAdmin(this.ctx, this.redisService);
    if (!body?.code) throw R.validateError('code 必填');
    return { success: true, data: await this.usService.upsertHolding(body) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '美股持仓删除',
    functionName: 'investUsHoldingsDelete',
    name: 'investUsHoldingsDelete',
    path: '/invest/us/holdings/delete',
    method: 'post',
  })
  async deleteHolding(@Body(ALL) body: { code: string }) {
    await assertAdmin(this.ctx, this.redisService);
    if (!body?.code) throw R.validateError('code 必填');
    return { success: true, data: await this.usService.deleteHolding(body.code) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '美股观察清单（含最新分级）',
    functionName: 'investUsWatchlist',
    name: 'investUsWatchlist',
    path: '/invest/us/watchlist',
    method: 'get',
  })
  async watchlist() {
    return { success: true, data: await this.usService.watchlist() };
  }
}
