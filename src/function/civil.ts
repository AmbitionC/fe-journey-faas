import { Inject, Provide, Query, ServerlessTrigger, ServerlessTriggerType } from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { NoAuth } from '../decorator/noAuth';
import { acceptsGzip } from '../common/datasetBody';
import { isCivilDatasetName, loadCivilDataset } from '../service/civil/staticData';

/**
 * 考公职位筛选器数据的国内下发（见 service/civil/staticData.ts）。
 * 公开数据（国家公务员局职位表 + 往年进面分汇总），不需要登录。
 */
@Provide()
export class CivilHTTPService {
  @Inject()
  ctx: Context;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '考公职位表 / 往年进面分数据（前端静态文件的杭州镜像，?v= 对版本）',
    functionName: 'civilData',
    name: 'civilData',
    path: '/civil/data',
    method: 'get',
  })
  @NoAuth()
  async data(@Query('name') name?: string, @Query('v') v?: string) {
    if (!isCivilDatasetName(name)) {
      this.ctx.status = 404;
      return { success: false, message: 'unknown dataset' };
    }
    const ds = loadCivilDataset(name);
    // 前端那份和镜像不是同一版：让前端回退到原文件，绝不下发旧数据
    if (v && v !== ds.version) {
      this.ctx.status = 409;
      return { success: false, message: 'version mismatch', version: ds.version };
    }
    this.ctx.set('Content-Type', 'application/json; charset=utf-8');
    // 带版本号的地址内容不会变，可以放心长缓存
    this.ctx.set('Cache-Control', v ? 'public, max-age=604800, immutable' : 'public, max-age=600');
    this.ctx.set('Vary', 'Accept-Encoding');
    if (acceptsGzip(this.ctx.get('accept-encoding'))) {
      this.ctx.set('Content-Encoding', 'gzip');
      return ds.gz;
    }
    return ds.raw;
  }
}
