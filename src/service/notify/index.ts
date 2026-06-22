import { Inject, Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { NotifySubscriptionEntity } from '../../entity/notifySubscription';
import { ArticleService } from '../article';
import { AiProxyService } from '../ai/proxy';
import { sendEmail } from './sender';

@Provide()
export class NotifyService {
  @InjectEntityModel(NotifySubscriptionEntity)
  subModel: Repository<NotifySubscriptionEntity>;

  @Inject()
  articleService: ArticleService;

  @Inject()
  aiProxyService: AiProxyService;

  async subscribe(p: {
    userId: string;
    channel: string;
    address: string;
    types?: string[];
  }) {
    const existing = await this.subModel.findOne({
      where: { userId: p.userId, channel: p.channel },
    });
    if (existing) {
      existing.address = p.address;
      existing.enabled = true;
      if (p.types) existing.types = p.types;
      return this.subModel.save(existing);
    }
    return this.subModel.save(
      this.subModel.create({
        userId: p.userId,
        channel: p.channel,
        address: p.address,
        enabled: true,
        types: p.types || ['review', 'weekly'],
      })
    );
  }

  async unsubscribe(userId: string, channel: string) {
    await this.subModel.update({ userId, channel }, { enabled: false });
    return { ok: true };
  }

  async status(userId: string) {
    const rows = await this.subModel.find({ where: { userId } });
    return { subscriptions: rows };
  }

  /**
   * 学习简报（PRD-06 F1/F2）：复习到期清单 + 可选周报文案。
   * 这是「要投递的内容」；实际邮件/服务号发送依赖渠道凭证与定时任务（见 PRD-06 待办）。
   */
  async digest(userId: string, module: string, withWeekly = false) {
    const profile = await this.articleService.getLearnerProfile(userId, module);
    const reviewDue = (profile?.reviewDueDetail || []).slice(0, 10);
    let weekly = '';
    if (withWeekly) {
      const summary = await this.articleService.getProfileSummary(userId, module);
      weekly = await this.aiProxyService.weeklyReport(
        {
          profileSummary: summary,
          weakTags: (profile?.weakTags || []).map((w) => w.tag),
          reviewDueCount: profile?.reviewDue?.length || 0,
          streak: profile?.streak || 0,
        },
        userId
      );
    }
    return { reviewDueCount: reviewDue.length, reviewDue, weekly, streak: profile?.streak || 0 };
  }

  private renderDigestHtml(d: any): string {
    const items = (d.reviewDue || [])
      .map((r: any) => `<li>${r.articleKey} —— ${r.reason}</li>`)
      .join('');
    return `<div style="font-family:sans-serif;max-width:560px">
      <h2>你的学习周报</h2>
      ${d.weekly ? `<p>${d.weekly}</p>` : ''}
      <p>连续学习 <b>${d.streak}</b> 天，待复习 <b>${d.reviewDueCount}</b> 篇：</p>
      <ul>${items || '<li>暂无到期内容，继续保持～</li>'}</ul>
      <p style="color:#888;font-size:12px">如不想再收到，可在站内取消订阅。</p>
    </div>`;
  }

  /**
   * 定时任务：给已订阅邮箱投递学习简报（PRD-06）。由 FC 定时触发器调用。
   * 缺 SMTP 配置时安全跳过（sent:false）。
   */
  async runDigestCron(limit = 200) {
    const subs = await this.subModel.find({
      where: { channel: 'email', enabled: true },
      take: limit,
    });
    let sent = 0;
    let skipped = 0;
    for (const s of subs) {
      try {
        const withWeekly = !s.types || s.types.includes('weekly');
        const digest = await this.digest(s.userId, 'knowledge', withWeekly);
        // 没有到期内容也没周报就不打扰
        if (!digest.reviewDueCount && !digest.weekly) {
          skipped += 1;
          continue;
        }
        const r = await sendEmail({
          to: s.address,
          subject: '你的学习周报 · Agent Journey',
          html: this.renderDigestHtml(digest),
        });
        if (r.sent) sent += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    return { total: subs.length, sent, skipped };
  }
}
