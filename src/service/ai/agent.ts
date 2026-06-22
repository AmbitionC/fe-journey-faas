import { Provide, Inject } from '@midwayjs/core';
import { RetrieveService } from './retrieve';
import { AiProxyService } from './proxy';
import { ArticleService } from '../article';
import { QuizService } from '../quiz';
import { sm2, DEFAULT_SRS } from '../article/sm2';

export interface PlanStep {
  step: 'retrieve' | 'generate' | 'schedule' | 'remind';
  label: string;
  ok: boolean;
  result: any;
}

/**
 * 编排式 Agent（PRD-02 F3-1）：把「查资料 → 出题 → 记录(排程) → 提醒」串成一个
 * 端到端可控的小闭环。确定性编排（非模型自主工具调用），每步失败可降级不中断。
 */
@Provide()
export class AgentService {
  @Inject()
  retrieveService: RetrieveService;

  @Inject()
  aiProxyService: AiProxyService;

  @Inject()
  articleService: ArticleService;

  @Inject()
  quizService: QuizService;

  async runStudyPlan(params: {
    userId: string;
    module: string;
    articleKey: string;
  }): Promise<{ steps: PlanStep[]; summary: string }> {
    const { userId, module, articleKey } = params;
    const steps: PlanStep[] = [];
    const leaf = await this.articleService.findLeafByKey(module, articleKey);
    const title = leaf?.label || articleKey;

    // 1) 查：召回站内相关资料
    let related: any[] = [];
    try {
      related = await this.retrieveService.retrieve(title.replace(/[-_]/g, ' '), {
        module,
        topK: 3,
      });
      steps.push({ step: 'retrieve', label: '查相关资料', ok: true, result: related });
    } catch (e: any) {
      steps.push({ step: 'retrieve', label: '查相关资料', ok: false, result: e?.message || '失败' });
    }

    // 2) 出题：基于文章自动出题入库为草稿
    let generated: any = { count: 0 };
    try {
      generated = await this.quizService.generate({ userId, module, articleKey, count: 3 });
      steps.push({
        step: 'generate',
        label: '自动出题',
        ok: generated.count > 0,
        result: { count: generated.count },
      });
    } catch (e: any) {
      steps.push({ step: 'generate', label: '自动出题', ok: false, result: e?.message || '失败' });
    }

    // 3) 记录：给出首次复习排程建议（不落库，纯计算）
    const next = sm2(DEFAULT_SRS, 'good', Date.now());
    steps.push({
      step: 'schedule',
      label: '安排复习',
      ok: true,
      result: { nextDueAt: next.dueAt, intervalDays: next.interval },
    });

    // 4) 提醒：生成一句教练提醒文案
    let tip = '';
    try {
      const summary = await this.articleService.getProfileSummary(userId, module);
      tip = await this.aiProxyService.coachTip(
        { profileSummary: summary, articleTitle: title },
        userId
      );
      steps.push({ step: 'remind', label: '生成提醒', ok: !!tip, result: tip });
    } catch (e: any) {
      steps.push({ step: 'remind', label: '生成提醒', ok: false, result: e?.message || '失败' });
    }

    const okCount = steps.filter((s) => s.ok).length;
    const summary = `已为《${title}》完成 ${okCount}/${steps.length} 步：查到 ${related.length} 篇相关资料、生成 ${generated.count || 0} 道题、安排了复习提醒。`;
    return { steps, summary };
  }
}
