import { Inject, Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import {
  OpsTaskEntity,
  ContentHealthReportEntity,
  OpsAuditLogEntity,
  SamplingCheckEntity,
} from '../../entity/ops';
import { ArticleService } from '../article';
import { checkContent, healthScore, extractLinks } from './contentHealth';
import { fetchArticleFromGitHub } from '../content/sync';
import fetch from 'node-fetch';

@Provide()
export class OpsService {
  @InjectEntityModel(OpsTaskEntity)
  taskModel: Repository<OpsTaskEntity>;

  @InjectEntityModel(ContentHealthReportEntity)
  reportModel: Repository<ContentHealthReportEntity>;

  @InjectEntityModel(OpsAuditLogEntity)
  auditModel: Repository<OpsAuditLogEntity>;

  @InjectEntityModel(SamplingCheckEntity)
  samplingModel: Repository<SamplingCheckEntity>;

  @Inject()
  articleService: ArticleService;

  /** 校验少量外链可达性（HEAD，超时即视为可疑）。 */
  private async verifyLinks(links: string[], limit = 5): Promise<string[]> {
    const dead: string[] = [];
    await Promise.all(
      links.slice(0, limit).map(async (url) => {
        try {
          const ctrl = new (global as any).AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal } as any);
          clearTimeout(timer);
          if (!res.ok && res.status >= 400) dead.push(`${url} (${res.status})`);
        } catch {
          dead.push(`${url} (无法访问)`);
        }
      })
    );
    return dead;
  }

  /** 对单篇文章做体检并落库报告（PRD-08 F1-2）。 */
  async runArticleHealth(module: string, articleKey: string) {
    const leaf = await this.articleService.findLeafByKey(module, articleKey);
    if (!leaf) throw new Error('未找到该文章');
    let content = '';
    try {
      content = await fetchArticleFromGitHub(module, leaf.filePath, articleKey);
    } catch {
      throw new Error('拉取文章内容失败');
    }
    const issues = checkContent(content);
    // 外链实测可达性，命中则升级为 link 死链问题
    const dead = await this.verifyLinks(extractLinks(content));
    for (const d of dead) {
      issues.push({ type: 'link', severity: 'high', detail: `死链：${d}` });
    }
    const score = healthScore(issues);
    const report = await this.reportModel.save(
      this.reportModel.create({ module, articleKey, score, issues })
    );
    return report;
  }

  async listReports(params: { page?: number; pageSize?: number; module?: string }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;
    const qb = this.reportModel.createQueryBuilder('r');
    if (params.module) qb.andWhere('r.module = :m', { m: params.module });
    const total = await qb.getCount();
    const list = await qb
      .orderBy('r.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();
    return { list, total };
  }

  async listTasks(params: { page?: number; pageSize?: number }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;
    const [list, total] = await this.taskModel.findAndCount({
      order: { id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { list, total };
  }

  async listAudit(params: { page?: number; pageSize?: number }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;
    const [list, total] = await this.auditModel.findAndCount({
      order: { id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { list, total };
  }

  async submitSampling(p: { taskId?: number; sampler?: string; result: string; note?: string }) {
    return this.samplingModel.save(this.samplingModel.create(p));
  }
}
