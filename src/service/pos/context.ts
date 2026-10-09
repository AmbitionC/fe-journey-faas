import { Provide, Inject, Config } from '@midwayjs/core';
import fetch from 'node-fetch';
import { PosDbService } from './db';
import { PosFinanceService } from './finance';
import { HealthBodyService } from '../health/body';
import {
  DOMAINS,
  NOTE_KINDS,
  classifyNoteByRule,
  guardEventStatus,
  isDate,
  normDate,
  nowCN,
  todayCN,
} from './logic';

const EVENT_TYPES = ['finance', 'career', 'health', 'family', 'growth', 'decision', 'milestone', 'other'];
const VISIBILITY = ['private_server', 'ai_summary_only', 'ai_allowed'];
const FACT_CATEGORIES = ['identity', 'value', 'principle', 'preference', 'constraint', 'direction'];
/** 手录指标白名单（防止随手写出一堆无定义的 key）。 */
export const MANUAL_METRICS: Record<string, { label: string; unit: string; domain: string }> = {
  'health.waist': { label: '腰围', unit: 'cm', domain: 'health' },
  'health.resting_hr': { label: '静息心率', unit: 'bpm', domain: 'health' },
  'subjective.weekly_energy': { label: '本周精力', unit: '1-5', domain: 'time' },
  'fx.usdcny': { label: '美元兑人民币', unit: 'CNY', domain: 'wealth' },
};

const pick = <T extends string>(v: any, list: readonly T[], dflt: T): T =>
  (list as readonly string[]).includes(v) ? (v as T) : dflt;

function parseJson(s: any): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const c = fenced ? fenced[1] : text;
  const s = c.indexOf('{');
  const e = c.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('未找到 JSON');
  return JSON.parse(c.slice(s, e + 1));
}

export interface TimelineItem {
  id: string;
  type: 'note' | 'event' | 'balance' | 'income' | 'body' | 'metric';
  date: string;
  time: string | null;
  title: string;
  detail: string | null;
  domain: string | null;
  status: string | null;
  factType: string | null;
  meta?: Record<string, any>;
}

/**
 * 上下文层：随手记 / 人生事件 / 关于我 / 目标 / 手录指标 / 时间线。
 * 原则（PRD §6.3/§8.3）：AI 只产出「建议」，确认后才落为事件/目标；计划≠已发生。
 */
@Provide()
export class PosContextService {
  @Inject()
  db: PosDbService;

  @Inject()
  finance: PosFinanceService;

  @Inject()
  bodyService: HealthBodyService;

  @Config('health')
  healthConfig: { chat: { baseUrl: string; apiKey: string; model: string } };

  // ------------------------------------------------------------ 随手记

  async capture(p: any) {
    const content = String(p?.content ?? p?.text ?? '').trim();
    if (!content) throw new Error('内容不能为空');
    if (content.length > 5000) throw new Error('单条内容请控制在 5000 字以内');
    const rule = classifyNoteByRule(content);
    const kind = pick(p.kind, NOTE_KINDS, rule.kind as any);
    const domain = (DOMAINS as readonly string[]).includes(p.domain) ? p.domain : rule.domain;
    // 家庭域默认不给 AI（PRD §15.1），除非显式允许
    const vis = pick(
      p.aiVisibility,
      VISIBILITY,
      domain === 'family' ? 'private_server' : 'ai_allowed'
    );
    const capturedAt =
      typeof p.capturedAt === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(p.capturedAt)
        ? p.capturedAt.replace('T', ' ').slice(0, 19)
        : nowCN();
    const r = await this.db.exec(
      `INSERT INTO pos_note (content, kind, domain, tags, source, ai_visibility, ai_status, captured_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        content,
        kind,
        domain,
        p.tags ? String(p.tags).slice(0, 255) : null,
        String(p.source || 'web').slice(0, 32),
        vis,
        vis === 'ai_allowed' ? 'pending' : 'skipped',
        capturedAt,
      ]
    );
    return this.note(r.insertId);
  }

  private noteRow(r: any) {
    return {
      id: r.id,
      content: r.content,
      kind: r.kind,
      domain: r.domain,
      tags: r.tags,
      source: r.source,
      aiVisibility: r.ai_visibility,
      aiStatus: r.ai_status,
      aiSuggestion: parseJson(r.ai_suggestion),
      capturedAt: r.captured_at,
      archived: !!r.archived,
    };
  }

  async note(id: number) {
    const r = await this.db.one('SELECT * FROM pos_note WHERE id=?', [Number(id)]);
    if (!r) throw new Error('记录不存在');
    return this.noteRow(r);
  }

  async notes(q: { days?: number; kind?: string; domain?: string; keyword?: string; limit?: number }) {
    const where: string[] = ['archived = 0'];
    const params: any[] = [];
    if (q.days) {
      where.push('captured_at >= DATE_SUB(?, INTERVAL ? DAY)');
      params.push(todayCN(), Number(q.days));
    }
    if (q.kind) {
      where.push('kind = ?');
      params.push(q.kind);
    }
    if (q.domain) {
      where.push('domain = ?');
      params.push(q.domain);
    }
    if (q.keyword) {
      where.push('content LIKE ?');
      params.push(`%${String(q.keyword).slice(0, 50)}%`);
    }
    params.push(Math.min(500, Number(q.limit) || 100));
    const rows = await this.db.q(
      `SELECT * FROM pos_note WHERE ${where.join(' AND ')} ORDER BY captured_at DESC LIMIT ?`,
      params
    );
    return rows.map(r => this.noteRow(r));
  }

  async updateNote(p: any) {
    const id = Number(p?.id);
    if (!id) throw new Error('id 必填');
    const sets: string[] = [];
    const params: any[] = [];
    if (p.content != null) {
      sets.push('content=?');
      params.push(String(p.content).slice(0, 5000));
    }
    if (p.kind) {
      sets.push('kind=?');
      params.push(pick(p.kind, NOTE_KINDS, 'note'));
    }
    if (p.domain !== undefined) {
      sets.push('domain=?');
      params.push((DOMAINS as readonly string[]).includes(p.domain) ? p.domain : null);
    }
    if (p.aiVisibility) {
      sets.push('ai_visibility=?');
      params.push(pick(p.aiVisibility, VISIBILITY, 'ai_allowed'));
    }
    if (p.archived !== undefined) {
      sets.push('archived=?');
      params.push(p.archived ? 1 : 0);
    }
    if (p.dismissSuggestion) {
      sets.push("ai_status='dismissed'");
    }
    if (!sets.length) return this.note(id);
    await this.db.exec(`UPDATE pos_note SET ${sets.join(', ')} WHERE id=?`, [...params, id]);
    return this.note(id);
  }

  async deleteNote(id: number) {
    await this.db.exec('DELETE FROM pos_note WHERE id=?', [Number(id)]);
  }

  /**
   * AI 整理一条随手记：分类 + 候选（事件/决定/目标/指标），只存为建议。
   * 未授权 AI 的记录直接跳过；LLM 不可用时退回规则分类（不生成候选）。
   */
  async analyzeNote(id: number) {
    const n = await this.note(id);
    if (n.aiVisibility !== 'ai_allowed') {
      await this.db.exec("UPDATE pos_note SET ai_status='skipped' WHERE id=?", [id]);
      return { ...n, aiStatus: 'skipped' };
    }
    const ep = this.healthConfig?.chat;
    let suggestion: any;
    if (!ep?.apiKey || !ep?.model) {
      suggestion = { ...classifyNoteByRule(n.content), candidates: [], by: 'rule' };
    } else {
      try {
        suggestion = await this.llmAnalyze(n.content, String(n.capturedAt).slice(0, 10));
      } catch (e: any) {
        suggestion = {
          ...classifyNoteByRule(n.content),
          candidates: [],
          by: 'rule',
          error: String(e?.message || e).slice(0, 120),
        };
      }
    }
    await this.db.exec(
      "UPDATE pos_note SET ai_status='done', ai_suggestion=?, kind=IF(kind='note',?,kind), domain=COALESCE(domain,?) WHERE id=?",
      [JSON.stringify(suggestion), suggestion.kind || 'note', suggestion.domain || null, id]
    );
    return this.note(id);
  }

  private async llmAnalyze(text: string, date: string) {
    const ep = this.healthConfig.chat;
    const prompt = `你在帮用户整理「随手记」。只做信息提取，不给建议、不评价。
记录日期：${date}
原文：${text}

只输出 JSON：
{"kind":"note|idea|worry|plan|decision|event|feeling",
 "domain":"wealth|career|health|time|family|growth|risk|life|null",
 "summary":"不超过30字的摘要",
 "candidates":[
   {"type":"event","title":"事件标题","status":"planned|done","date":"YYYY-MM-DD或null","amount":数字或null,"currency":"CNY","domain":"..."},
   {"type":"decision","title":"决定了什么","reason":"理由或null"},
   {"type":"goal","title":"目标","domain":"..."},
   {"type":"metric","key":"health.waist|health.resting_hr|subjective.weekly_energy","value":数字,"date":"YYYY-MM-DD"}
 ]}
硬规则：
1. 原文说「打算/计划/准备/想/下周」的，事件 status 必须是 planned，不得写成 done。
2. 原文没明确给出的数字/日期一律 null，不要推测；「两三万」这类模糊数不要放进 amount。
3. 没有可提取的就给空数组；candidates 最多 3 个。`;
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({
        model: ep.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0.1,
      }),
      timeout: 25000,
    } as any);
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data: any = await res.json();
    const parsed = extractJson(data?.choices?.[0]?.message?.content || '');
    const candidates = (Array.isArray(parsed.candidates) ? parsed.candidates : [])
      .slice(0, 3)
      .map((c: any) => {
        if (c?.type === 'event')
          return {
            type: 'event',
            title: String(c.title || '').slice(0, 200),
            // 护栏：计划永远不能被当成已发生
            status: guardEventStatus(text, c.status),
            date: isDate(c.date) ? c.date : null,
            amount: Number.isFinite(Number(c.amount)) && c.amount != null ? Number(c.amount) : null,
            currency: /^[A-Z]{3}$/.test(c.currency || '') ? c.currency : 'CNY',
            domain: (DOMAINS as readonly string[]).includes(c.domain) ? c.domain : null,
          };
        if (c?.type === 'decision')
          return { type: 'decision', title: String(c.title || '').slice(0, 200), reason: c.reason || null };
        if (c?.type === 'goal')
          return {
            type: 'goal',
            title: String(c.title || '').slice(0, 200),
            domain: (DOMAINS as readonly string[]).includes(c.domain) ? c.domain : null,
          };
        if (c?.type === 'metric' && MANUAL_METRICS[c.key] && Number.isFinite(Number(c.value)))
          return {
            type: 'metric',
            key: c.key,
            value: Number(c.value),
            date: isDate(c.date) ? c.date : date,
          };
        return null;
      })
      .filter((c: any) => c && (c.title || c.key));
    return {
      kind: (NOTE_KINDS as readonly string[]).includes(parsed.kind) ? parsed.kind : 'note',
      domain: (DOMAINS as readonly string[]).includes(parsed.domain) ? parsed.domain : null,
      summary: String(parsed.summary || '').slice(0, 60),
      candidates,
      by: 'llm',
    };
  }

  // ------------------------------------------------------------ 事件

  private eventRow(r: any) {
    return {
      id: r.id,
      title: r.title,
      detail: r.detail,
      domain: r.domain,
      eventType: r.event_type,
      status: r.status,
      plannedDate: normDate(r.planned_date),
      occurredDate: normDate(r.occurred_date),
      amount: r.amount == null ? null : Number(r.amount),
      currency: r.currency,
      data: parseJson(r.data_json) || {},
      factType: r.fact_type,
      noteId: r.note_id,
      source: r.source,
      createdAt: r.created_at,
    };
  }

  async events(q: { status?: string; days?: number; limit?: number }) {
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (q.status) {
      where.push('status=?');
      params.push(q.status);
    }
    params.push(Math.min(500, Number(q.limit) || 200));
    const rows = await this.db.q(
      `SELECT * FROM pos_event WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(occurred_date, planned_date) DESC, id DESC LIMIT ?`,
      params
    );
    return rows.map(r => this.eventRow(r));
  }

  async upsertEvent(p: any) {
    const title = String(p?.title || '').trim().slice(0, 200);
    if (!title) throw new Error('标题必填');
    const status = pick(p.status, ['planned', 'done', 'cancelled'] as const, 'done');
    const plannedDate = isDate(p.plannedDate) ? p.plannedDate : null;
    let occurredDate = isDate(p.occurredDate) ? p.occurredDate : null;
    if (status === 'done' && !occurredDate) occurredDate = todayCN();
    if (status === 'done' && occurredDate! > todayCN())
      throw new Error('发生日期不能晚于今天（未来的事请记为「计划中」）');
    if (status === 'planned' && occurredDate)
      throw new Error('计划中的事件不能有发生日期（执行后再「标记已执行」）');
    const amount = p.amount == null || p.amount === '' ? null : Number(p.amount);
    if (amount != null && !Number.isFinite(amount)) throw new Error('金额不合法');
    const vals = [
      title,
      p.detail ? String(p.detail).slice(0, 5000) : null,
      (DOMAINS as readonly string[]).includes(p.domain) ? p.domain : null,
      pick(p.eventType, EVENT_TYPES as any, 'other'),
      status,
      plannedDate,
      occurredDate,
      amount,
      /^[A-Z]{3}$/.test(p.currency || '') ? p.currency : 'CNY',
      JSON.stringify(p.data && typeof p.data === 'object' ? p.data : {}),
      status === 'planned' ? 'planned' : pick(p.factType, ['reported', 'measured', 'imported'] as const, 'reported'),
      p.noteId ? Number(p.noteId) : null,
      String(p.source || 'web').slice(0, 32),
    ];
    if (p.id) {
      await this.db.exec(
        `UPDATE pos_event SET title=?, detail=?, domain=?, event_type=?, status=?, planned_date=?, occurred_date=?,
          amount=?, currency=?, data_json=?, fact_type=?, note_id=?, source=? WHERE id=?`,
        [...vals, Number(p.id)]
      );
      return this.event(Number(p.id));
    }
    const r = await this.db.exec(
      `INSERT INTO pos_event (title, detail, domain, event_type, status, planned_date, occurred_date,
        amount, currency, data_json, fact_type, note_id, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      vals
    );
    return this.event(r.insertId);
  }

  async event(id: number) {
    const r = await this.db.one('SELECT * FROM pos_event WHERE id=?', [id]);
    if (!r) throw new Error('事件不存在');
    return this.eventRow(r);
  }

  /**
   * 计划 → 已执行（PRD §10.3 / 场景 3）。财务类事件必须说明资金来源：
   * 要么给出账户结转 effects（同时改资金账户与负债），要么填 fundingSource 文字说明。
   */
  async completeEvent(p: any) {
    const e = await this.event(Number(p?.id));
    if (e.status === 'done') throw new Error('该事件已是「已执行」状态');
    const occurredDate = isDate(p.occurredDate) ? p.occurredDate : todayCN();
    if (occurredDate > todayCN()) throw new Error('发生日期不能晚于今天（还没发生就保持「计划中」）');
    const amount = p.amount == null || p.amount === '' ? e.amount : Number(p.amount);
    const effects: Array<{ accountId: number; delta: number }> = Array.isArray(p.effects)
      ? p.effects
          .map((x: any) => ({ accountId: Number(x.accountId), delta: Number(x.delta) }))
          .filter((x: any) => x.accountId && Number.isFinite(x.delta) && x.delta !== 0)
      : [];
    const fundingSource = p.fundingSource ? String(p.fundingSource).slice(0, 200) : null;
    if (e.eventType === 'finance' && !effects.length && !fundingSource)
      throw new Error('财务事件结转需要说明资金来源（选择账户，或填写资金来源说明）');
    let applied: any[] = [];
    if (effects.length)
      applied = await this.finance.applyEventEffects(occurredDate, effects, `事件结转：${e.title}`);
    const data = { ...(e.data || {}), fundingSource, effects: applied, completedAt: nowCN() };
    await this.db.exec(
      "UPDATE pos_event SET status='done', occurred_date=?, amount=?, fact_type='reported', data_json=? WHERE id=?",
      [occurredDate, amount, JSON.stringify(data), e.id]
    );
    return this.event(e.id);
  }

  async deleteEvent(id: number) {
    await this.db.exec('DELETE FROM pos_event WHERE id=?', [Number(id)]);
  }

  // ------------------------------------------------------------ 关于我 / 目标

  async facts(includeInactive = false) {
    const rows = await this.db.q(
      `SELECT * FROM pos_fact ${includeInactive ? '' : "WHERE status='active'"} ORDER BY category, id`
    );
    return rows.map((r: any) => ({
      id: r.id,
      category: r.category,
      label: r.label,
      content: r.content,
      factType: r.fact_type,
      status: r.status,
      aiVisibility: r.ai_visibility,
      validFrom: normDate(r.valid_from),
      validTo: normDate(r.valid_to),
      updatedAt: r.updated_at,
    }));
  }

  /** 更正事实：旧版本置 superseded 保留历史，再写新版本（PRD §6.4）。 */
  async upsertFact(p: any) {
    const label = String(p?.label || '').trim().slice(0, 64);
    const content = String(p?.content || '').trim();
    if (!label || !content) throw new Error('标题和内容必填');
    const category = pick(p.category, FACT_CATEGORIES as any, 'identity');
    const vis = pick(p.aiVisibility, VISIBILITY as any, 'ai_allowed');
    if (p.id) {
      await this.db.exec(
        "UPDATE pos_fact SET status='superseded', valid_to=? WHERE id=?",
        [todayCN(), Number(p.id)]
      );
    }
    const r = await this.db.exec(
      `INSERT INTO pos_fact (category, label, content, fact_type, status, ai_visibility, valid_from)
       VALUES (?,?,?,?, 'active', ?, ?)`,
      [category, label, content.slice(0, 5000), 'reported', vis, todayCN()]
    );
    return { id: r.insertId };
  }

  /** 设为过期 / 隐藏（不再被引用）/ 删除。 */
  async setFactStatus(id: number, status: string) {
    if (status === 'deleted') {
      await this.db.exec('DELETE FROM pos_fact WHERE id=?', [Number(id)]);
      return;
    }
    const s = pick(status, ['active', 'superseded', 'hidden'] as const, 'hidden');
    await this.db.exec('UPDATE pos_fact SET status=?, valid_to=? WHERE id=?', [
      s,
      s === 'active' ? null : todayCN(),
      Number(id),
    ]);
  }

  async goals(includeClosed = false) {
    const rows = await this.db.q(
      `SELECT * FROM pos_goal ${includeClosed ? '' : "WHERE status IN ('active','paused')"} ORDER BY status, target_date IS NULL, target_date, id`
    );
    return rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      domain: r.domain,
      metricKey: r.metric_key,
      baseline: r.baseline == null ? null : Number(r.baseline),
      target: r.target == null ? null : Number(r.target),
      unit: r.unit,
      targetDate: normDate(r.target_date),
      status: r.status,
      why: r.why,
    }));
  }

  async upsertGoal(p: any) {
    const title = String(p?.title || '').trim().slice(0, 200);
    if (!title) throw new Error('目标必填');
    const n = (v: any) => (v == null || v === '' ? null : Number(v));
    const vals = [
      title,
      (DOMAINS as readonly string[]).includes(p.domain) ? p.domain : null,
      p.metricKey ? String(p.metricKey).slice(0, 48) : null,
      n(p.baseline),
      n(p.target),
      p.unit ? String(p.unit).slice(0, 16) : null,
      isDate(p.targetDate) ? p.targetDate : null,
      pick(p.status, ['active', 'paused', 'done', 'dropped'] as const, 'active'),
      p.why ? String(p.why).slice(0, 2000) : null,
    ];
    if (p.id) {
      await this.db.exec(
        'UPDATE pos_goal SET title=?, domain=?, metric_key=?, baseline=?, target=?, unit=?, target_date=?, status=?, why=? WHERE id=?',
        [...vals, Number(p.id)]
      );
      return { id: Number(p.id) };
    }
    const r = await this.db.exec(
      'INSERT INTO pos_goal (title, domain, metric_key, baseline, target, unit, target_date, status, why) VALUES (?,?,?,?,?,?,?,?,?)',
      vals
    );
    return { id: r.insertId };
  }

  async deleteGoal(id: number) {
    await this.db.exec('DELETE FROM pos_goal WHERE id=?', [Number(id)]);
  }

  // ------------------------------------------------------------ 手录指标

  async recordMetric(p: any) {
    const key = String(p?.key || '');
    const def = MANUAL_METRICS[key];
    if (!def) throw new Error(`不支持的指标：${key}`);
    const value = Number(p.value);
    if (!Number.isFinite(value)) throw new Error('数值不合法');
    const date = isDate(p.date) ? p.date : todayCN();
    await this.db.exec(
      `INSERT INTO pos_metric (metric_key, observed_on, value, unit, fact_type, source, note)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE value=VALUES(value), fact_type=VALUES(fact_type), source=VALUES(source), note=VALUES(note)`,
      [
        key,
        date,
        value,
        def.unit,
        pick(p.factType, ['measured', 'reported', 'estimated'] as const, 'measured'),
        String(p.source || 'web').slice(0, 32),
        p.note ? String(p.note).slice(0, 255) : null,
      ]
    );
    return { key, date, value };
  }

  async metricHistory(key: string, days = 365) {
    const rows = await this.db.q(
      'SELECT id, observed_on, value, unit, fact_type, note FROM pos_metric WHERE metric_key=? AND observed_on >= DATE_SUB(?, INTERVAL ? DAY) ORDER BY observed_on',
      [key, todayCN(), Number(days) || 365]
    );
    return rows.map((r: any) => ({
      id: r.id,
      date: normDate(r.observed_on),
      value: Number(r.value),
      unit: r.unit,
      factType: r.fact_type,
      note: r.note,
    }));
  }

  async deleteMetric(id: number) {
    await this.db.exec('DELETE FROM pos_metric WHERE id=?', [Number(id)]);
  }

  async latestMetric(key: string) {
    const r = await this.db.one(
      'SELECT observed_on, value FROM pos_metric WHERE metric_key=? ORDER BY observed_on DESC LIMIT 1',
      [key]
    );
    return r ? { date: normDate(r.observed_on)!, value: Number(r.value) } : null;
  }

  // ------------------------------------------------------------ 时间线

  /** 统一时间线：随手记 + 事件 + 余额核对 + 收入 + 体成分 + 手录指标（按日期倒序）。 */
  async timeline(q: { days?: number; types?: string; domain?: string }): Promise<TimelineItem[]> {
    const days = Math.min(3650, Number(q.days) || 30);
    const since = new Date(Date.parse(`${todayCN()}T00:00:00Z`) - days * 86400000)
      .toISOString()
      .slice(0, 10);
    const want = new Set(
      String(q.types || 'note,event,balance,income,body,metric')
        .split(',')
        .map(s => s.trim())
    );
    const items: TimelineItem[] = [];
    const tasks: Promise<void>[] = [];

    if (want.has('note'))
      tasks.push(
        this.db
          .q('SELECT * FROM pos_note WHERE archived=0 AND captured_at >= ? ORDER BY captured_at DESC LIMIT 300', [since])
          .then(rows => {
            for (const r of rows as any[]) {
              const sug = parseJson(r.ai_suggestion);
              items.push({
                id: `note:${r.id}`,
                type: 'note',
                date: String(r.captured_at).slice(0, 10),
                time: String(r.captured_at).slice(11, 16) || null,
                title: sug?.summary || String(r.content).slice(0, 60),
                detail: r.content,
                domain: r.domain,
                status: r.kind,
                factType: 'reported',
                meta: { aiStatus: r.ai_status, source: r.source },
              });
            }
          })
      );
    if (want.has('event'))
      tasks.push(
        this.db
          .q(
            `SELECT * FROM pos_event WHERE COALESCE(occurred_date, planned_date, DATE(created_at)) >= ?
             ORDER BY id DESC LIMIT 300`,
            [since]
          )
          .then(rows => {
            for (const r of rows as any[]) {
              const e = this.eventRow(r);
              items.push({
                id: `event:${e.id}`,
                type: 'event',
                date: e.occurredDate || e.plannedDate || String(r.created_at).slice(0, 10),
                time: null,
                title: e.title,
                detail: e.detail,
                domain: e.domain,
                status: e.status,
                factType: e.factType,
                meta: { amount: e.amount, currency: e.currency, eventType: e.eventType },
              });
            }
          })
      );
    if (want.has('balance'))
      tasks.push(
        this.db
          .q(
            `SELECT b.id, b.as_of, b.amount, b.fact_type, b.note, a.name, a.side, a.currency
             FROM pos_balance b JOIN pos_account a ON a.id=b.account_id WHERE b.as_of >= ? ORDER BY b.as_of DESC LIMIT 200`,
            [since]
          )
          .then(rows => {
            for (const r of rows as any[])
              items.push({
                id: `balance:${r.id}`,
                type: 'balance',
                date: normDate(r.as_of)!,
                time: null,
                title: `${r.name} ${r.side === 'liability' ? '欠款' : '余额'} ${Number(r.amount).toLocaleString('zh-CN')} ${r.currency}`,
                detail: r.note,
                domain: 'wealth',
                status: null,
                factType: r.fact_type,
              });
          })
      );
    if (want.has('income'))
      tasks.push(
        this.db
          .q(`SELECT * FROM pos_income WHERE COALESCE(received_date, CONCAT(period, '-01')) >= ? ORDER BY period DESC LIMIT 200`, [since])
          .then(rows => {
            const label: Record<string, string> = { salary: '工资', bonus: '奖金', equity: '长期激励', side: '副业收入', other: '其他收入' };
            const basis: Record<string, string> = { gross: '税前', net: '税后', unknown: '税前/税后未注明' };
            for (const r of rows as any[])
              items.push({
                id: `income:${r.id}`,
                type: 'income',
                date: normDate(r.received_date) || `${r.period}-01`,
                time: null,
                title: `${label[r.kind] || r.kind} ${Number(r.amount).toLocaleString('zh-CN')} ${r.currency}（${basis[r.basis] || r.basis}）`,
                detail: r.note,
                domain: 'career',
                status: null,
                factType: r.fact_type,
              });
          })
      );
    if (want.has('metric'))
      tasks.push(
        this.db
          .q('SELECT * FROM pos_metric WHERE observed_on >= ? ORDER BY observed_on DESC LIMIT 200', [since])
          .then(rows => {
            for (const r of rows as any[]) {
              const def = MANUAL_METRICS[r.metric_key];
              items.push({
                id: `metric:${r.id}`,
                type: 'metric',
                date: normDate(r.observed_on)!,
                time: null,
                title: `${def?.label || r.metric_key} ${Number(r.value)} ${r.unit || ''}`.trim(),
                detail: r.note,
                domain: def?.domain || null,
                status: null,
                factType: r.fact_type,
              });
            }
          })
      );
    if (want.has('body'))
      tasks.push(
        this.bodyService
          .list(200)
          .then(rows => {
            for (const b of rows) {
              if (b.date < since) continue;
              items.push({
                id: `body:${b.date}`,
                type: 'body',
                date: b.date,
                time: null,
                title:
                  `体重 ${b.weightKg} kg` + (b.bodyFatPct != null ? ` · 体脂 ${b.bodyFatPct}%` : ''),
                detail: b.notes,
                domain: 'health',
                status: null,
                factType: 'measured',
              });
            }
          })
          .catch(() => undefined)
      );
    await Promise.all(tasks);
    const filtered = q.domain ? items.filter(i => i.domain === q.domain) : items;
    return filtered.sort((a, b) =>
      a.date === b.date ? String(b.time || '').localeCompare(String(a.time || '')) : b.date.localeCompare(a.date)
    );
  }
}
