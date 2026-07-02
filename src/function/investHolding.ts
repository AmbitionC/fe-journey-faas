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
import { InvestHoldingService } from '../service/invest/holding';
import { SnapshotRowInput } from '../service/invest/calc';
import { assertAdmin } from '../common/admin.guard';
import { R } from '../common/base.error.utils';

/** 持仓 API：读=登录即可；写（编辑/录入/删除）=管理员。 */
@Provide()
export class InvestHoldingHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  holdingService: InvestHoldingService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '当前持仓',
    functionName: 'investHoldingsCurrent',
    name: 'investHoldingsCurrent',
    path: '/invest/holdings/current',
    method: 'get',
  })
  async current() {
    return { success: true, data: await this.holdingService.current() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '当前持仓新增/编辑',
    functionName: 'investHoldingsCurrentSave',
    name: 'investHoldingsCurrentSave',
    path: '/invest/holdings/current',
    method: 'post',
  })
  async saveCurrent(
    @Body(ALL) body: { code: string; shares: number; cost_price: number; entry_date?: string }
  ) {
    assertAdmin(this.ctx);
    if (!body?.code) throw R.validateError('code 必填');
    return { success: true, data: await this.holdingService.upsertCurrent(body) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '当前持仓删除',
    functionName: 'investHoldingsCurrentDelete',
    name: 'investHoldingsCurrentDelete',
    path: '/invest/holdings/current/delete',
    method: 'post',
  })
  async deleteCurrent(@Body(ALL) body: { code: string }) {
    assertAdmin(this.ctx);
    if (!body?.code) throw R.validateError('code 必填');
    return { success: true, data: await this.holdingService.deleteCurrent(body.code) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '快照日期列表',
    functionName: 'investSnapshotDates',
    name: 'investSnapshotDates',
    path: '/invest/holdings/snapshot/dates',
    method: 'get',
  })
  async snapshotDates() {
    return { success: true, data: await this.holdingService.snapshotDates() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '某日持仓快照',
    functionName: 'investSnapshot',
    name: 'investSnapshot',
    path: '/invest/holdings/snapshot',
    method: 'get',
  })
  async snapshot(@Query(ALL) q: { date?: string }) {
    return { success: true, data: await this.holdingService.snapshot(q.date) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '快照批量录入/覆盖（重算账户快照）',
    functionName: 'investSnapshotSave',
    name: 'investSnapshotSave',
    path: '/invest/holdings/snapshot',
    method: 'post',
  })
  async saveSnapshot(
    @Body(ALL) body: { snapshot_date: string; cash: number; rows: SnapshotRowInput[] }
  ) {
    assertAdmin(this.ctx);
    if (!body?.snapshot_date || !Array.isArray(body.rows)) {
      throw R.validateError('snapshot_date / rows 必填');
    }
    return {
      success: true,
      data: await this.holdingService.saveSnapshot({
        snapshot_date: body.snapshot_date,
        cash: Number(body.cash) || 0,
        rows: body.rows,
      }),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '快照单行删除（重算账户快照）',
    functionName: 'investSnapshotDelete',
    name: 'investSnapshotDelete',
    path: '/invest/holdings/snapshot/delete',
    method: 'post',
  })
  async deleteSnapshotRow(@Body(ALL) body: { snapshot_date: string; code: string }) {
    assertAdmin(this.ctx);
    if (!body?.snapshot_date || !body?.code) throw R.validateError('snapshot_date / code 必填');
    return {
      success: true,
      data: await this.holdingService.deleteSnapshotRow(body.snapshot_date, body.code),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '单标的持仓时序',
    functionName: 'investHoldingHistory',
    name: 'investHoldingHistory',
    path: '/invest/holdings/history',
    method: 'get',
  })
  async history(@Query(ALL) q: { code: string; start?: string; end?: string }) {
    if (!q?.code) throw R.validateError('code 必填');
    return {
      success: true,
      data: await this.holdingService.history(q.code, q.start, q.end),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '全部持仓按日市值（持仓变化）',
    functionName: 'investPositionSeries',
    name: 'investPositionSeries',
    path: '/invest/holdings/positions',
    method: 'get',
  })
  async positions(@Query(ALL) q: { start?: string; end?: string }) {
    return {
      success: true,
      data: await this.holdingService.positionSeries(q.start, q.end),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '账户净值序列',
    functionName: 'investAccountSeries',
    name: 'investAccountSeries',
    path: '/invest/account/series',
    method: 'get',
  })
  async accountSeries(@Query(ALL) q: { start?: string; end?: string }) {
    return {
      success: true,
      data: await this.holdingService.accountSeries(q.start, q.end),
    };
  }
}
