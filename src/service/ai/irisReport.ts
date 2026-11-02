import { Provide, Inject, Scope, ScopeEnum } from '@midwayjs/core';
import { TypeORMDataSourceManager } from '@midwayjs/typeorm';
import { customAlphabet } from 'nanoid';
import { R } from '../../common/base.error.utils';
import type { QueryFn } from '../../mcp/store';

/**
 * 模拟面试复盘报告（Iris 会员专享，irisCost('report') 点一份）。
 *
 * 一场面试结束后，把整段对话交给更强的模型出一份结构化 JSON 报告（见 prompts.buildInterviewReportMessages），
 * 存 iris_report，带一个短分享码。两种读法：
 * - 本人：完整报告（含每题的原题与表现）；
 * - 分享页 /r/iris/<code>（公开、免登录）：**不含原题与候选人原话**——面经题目是会员数据，
 *   分享出去的只是「这个人在这类面试里的表现画像」+ 邀请码 CTA，这是裂变入口不是题库出口。
 */
export interface InterviewReport {
  /** 0-100 */
  score: number;
  /** 一句话总评 */
  verdict: string;
  /** 建议岗位级别判断，如「初级 / 中级 / 高级」 */
  level?: string;
  strengths: string[];
  weaknesses: string[];
  perQuestion: { question: string; topic?: string; performance: string; keyPoint?: string; score?: number }[];
  /** 建议复习的考点（名称） */
  reviewTopics: string[];
  nextSteps: string[];
}

export interface ReportRow {
  id: number;
  code: string;
  user_id: string;
  label: string;
  topic: string | null;
  question_count: number;
  score: number;
  report: string;
  model: string | null;
  created_at: string;
}

const genCode = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 10);

export function parseReportJson(text: string): InterviewReport {
  const t = String(text || '').trim();
  const body = t.startsWith('```') ? t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '') : t;
  let raw: any;
  try {
    raw = JSON.parse(body);
  } catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) throw R.error('报告生成失败：模型未返回结构化结果，点数已退回');
    raw = JSON.parse(m[0]);
  }
  const arr = (v: any, n = 12): string[] =>
    Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean).slice(0, n) : [];
  const score = Math.max(0, Math.min(100, Math.round(Number(raw.score) || 0)));
  return {
    score,
    verdict: String(raw.verdict || raw.summary || '').trim().slice(0, 300),
    level: raw.level ? String(raw.level).slice(0, 20) : undefined,
    strengths: arr(raw.strengths),
    weaknesses: arr(raw.weaknesses),
    perQuestion: Array.isArray(raw.perQuestion)
      ? raw.perQuestion.slice(0, 20).map((q: any) => ({
          question: String(q?.question || '').slice(0, 300),
          topic: q?.topic ? String(q.topic).slice(0, 60) : undefined,
          performance: String(q?.performance || '').slice(0, 300),
          keyPoint: q?.keyPoint ? String(q.keyPoint).slice(0, 300) : undefined,
          score: q?.score != null ? Math.max(0, Math.min(10, Math.round(Number(q.score) || 0))) : undefined,
        }))
      : [],
    reviewTopics: arr(raw.reviewTopics, 10),
    nextSteps: arr(raw.nextSteps, 6),
  };
}

/** 分享页视图：去掉原题与候选人原话，只留表现画像。 */
export function sharedView(row: ReportRow, report: InterviewReport) {
  return {
    code: row.code,
    label: row.label,
    topic: row.topic,
    questionCount: row.question_count,
    createdAt: row.created_at,
    score: report.score,
    verdict: report.verdict,
    level: report.level || null,
    strengths: report.strengths,
    weaknesses: report.weaknesses,
    reviewTopics: report.reviewTopics,
    perQuestion: report.perQuestion.map(q => ({
      topic: q.topic || null,
      score: q.score ?? null,
    })),
  };
}

export class IrisReportStore {
  private schemaReady: Promise<void> | null = null;
  constructor(private q: QueryFn) {}

  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.q(`CREATE TABLE IF NOT EXISTS iris_report (
          id INT AUTO_INCREMENT PRIMARY KEY,
          code VARCHAR(16) NOT NULL,
          user_id VARCHAR(64) NOT NULL,
          label VARCHAR(120) NOT NULL DEFAULT '',
          topic VARCHAR(120) NULL,
          question_count INT NOT NULL DEFAULT 0,
          score INT NOT NULL DEFAULT 0,
          report MEDIUMTEXT NOT NULL,
          transcript MEDIUMTEXT NULL,
          model VARCHAR(64) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_iris_report_code (code),
          KEY idx_iris_report_user (user_id, created_at)
        ) DEFAULT CHARSET=utf8mb4`).then(
        () => undefined,
        e => {
          this.schemaReady = null;
          throw e;
        }
      );
    }
    return this.schemaReady;
  }

  async save(p: {
    userId: string;
    label: string;
    topic?: string | null;
    questionCount: number;
    report: InterviewReport;
    transcript?: string | null;
    model?: string | null;
  }): Promise<string> {
    await this.ensureSchema();
    for (let i = 0; i < 3; i++) {
      const code = genCode();
      try {
        await this.q(
          'INSERT INTO iris_report (code, user_id, label, topic, question_count, score, report, transcript, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            code,
            p.userId,
            String(p.label || '').slice(0, 120),
            p.topic ? String(p.topic).slice(0, 120) : null,
            p.questionCount,
            p.report.score,
            JSON.stringify(p.report),
            p.transcript ? String(p.transcript).slice(0, 200000) : null,
            p.model || null,
          ]
        );
        return code;
      } catch (e: any) {
        if (!/duplicate/i.test(String(e?.message || ''))) throw e;
      }
    }
    throw R.error('报告保存失败，请重试');
  }

  async byCode(code: string): Promise<ReportRow | null> {
    await this.ensureSchema();
    const c = String(code || '').trim();
    if (!/^[0-9a-z]{6,16}$/.test(c)) return null;
    const rows = await this.q(
      'SELECT id, code, user_id, label, topic, question_count, score, report, model, created_at FROM iris_report WHERE code = ? LIMIT 1',
      [c]
    );
    return rows?.[0] || null;
  }

  async listOf(userId: string, limit = 20): Promise<ReportRow[]> {
    await this.ensureSchema();
    return this.q(
      'SELECT id, code, user_id, label, topic, question_count, score, report, model, created_at FROM iris_report WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [userId, limit]
    );
  }
}

@Provide()
@Scope(ScopeEnum.Singleton)
export class IrisReportService {
  @Inject()
  dataSourceManager: TypeORMDataSourceManager;

  store: IrisReportStore | null = null;

  private getStore(): IrisReportStore {
    if (!this.store) {
      const ds = this.dataSourceManager.getDataSource('default');
      this.store = new IrisReportStore((sql, params) => ds.query(sql, params));
    }
    return this.store;
  }

  save: IrisReportStore['save'] = p => this.getStore().save(p);
  byCode: IrisReportStore['byCode'] = c => this.getStore().byCode(c);
  listOf: IrisReportStore['listOf'] = (u, l) => this.getStore().listOf(u, l);
}
