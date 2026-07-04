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
import { InvestAdvisorService } from '../service/invest/advisor';
import { assertAdmin } from '../common/admin.guard';
import { R } from '../common/base.error.utils';

/** 投顾消息/主题 API：读=登录；增删改=管理员。 */
@Provide()
export class InvestAdvisorHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  advisorService: InvestAdvisorService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '投顾个股信号列表',
    functionName: 'investAdvisorReco',
    name: 'investAdvisorReco',
    path: '/invest/advisor/reco',
    method: 'get',
  })
  async listReco(
    @Query(ALL)
    q: {
      start?: string; end?: string; grade?: string; direction?: string;
      sourceType?: string; code?: string; activeOnly?: string;
      page?: string; pageSize?: string;
    }
  ) {
    return {
      success: true,
      data: await this.advisorService.listReco({
        ...q,
        activeOnly: q.activeOnly === '1' || q.activeOnly === 'true',
        page: Number(q.page) || 1,
        pageSize: Number(q.pageSize) || 50,
      }),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '投顾个股信号新增/编辑',
    functionName: 'investAdvisorRecoSave',
    name: 'investAdvisorRecoSave',
    path: '/invest/advisor/reco',
    method: 'post',
  })
  async saveReco(@Body(ALL) body: any) {
    await assertAdmin(this.ctx, this.redisService);
    if (!body?.rec_date || !body?.code || !body?.source_type) {
      throw R.validateError('rec_date / code / source_type 必填');
    }
    return { success: true, data: await this.advisorService.upsertReco(body) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '投顾个股信号删除',
    functionName: 'investAdvisorRecoDelete',
    name: 'investAdvisorRecoDelete',
    path: '/invest/advisor/reco/delete',
    method: 'post',
  })
  async deleteReco(@Body(ALL) body: { rec_date: string; code: string; source_type: string }) {
    await assertAdmin(this.ctx, this.redisService);
    if (!body?.rec_date || !body?.code || !body?.source_type) {
      throw R.validateError('rec_date / code / source_type 必填');
    }
    return { success: true, data: await this.advisorService.deleteReco(body) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '投顾主题信号列表',
    functionName: 'investAdvisorTheme',
    name: 'investAdvisorTheme',
    path: '/invest/advisor/theme',
    method: 'get',
  })
  async listTheme(
    @Query(ALL)
    q: {
      start?: string; end?: string; direction?: string; sourceType?: string;
      activeOnly?: string; page?: string; pageSize?: string;
    }
  ) {
    return {
      success: true,
      data: await this.advisorService.listTheme({
        ...q,
        activeOnly: q.activeOnly === '1' || q.activeOnly === 'true',
        page: Number(q.page) || 1,
        pageSize: Number(q.pageSize) || 50,
      }),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '投顾主题新增/编辑',
    functionName: 'investAdvisorThemeSave',
    name: 'investAdvisorThemeSave',
    path: '/invest/advisor/theme',
    method: 'post',
  })
  async saveTheme(@Body(ALL) body: any) {
    await assertAdmin(this.ctx, this.redisService);
    if (!body?.rec_date || !body?.theme || !body?.source_type) {
      throw R.validateError('rec_date / theme / source_type 必填');
    }
    return { success: true, data: await this.advisorService.upsertTheme(body) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '投顾主题删除',
    functionName: 'investAdvisorThemeDelete',
    name: 'investAdvisorThemeDelete',
    path: '/invest/advisor/theme/delete',
    method: 'post',
  })
  async deleteTheme(@Body(ALL) body: { rec_date: string; theme: string; source_type: string }) {
    await assertAdmin(this.ctx, this.redisService);
    if (!body?.rec_date || !body?.theme || !body?.source_type) {
      throw R.validateError('rec_date / theme / source_type 必填');
    }
    return { success: true, data: await this.advisorService.deleteTheme(body) };
  }
}
