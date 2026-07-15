import { Provide, Inject, Config } from '@midwayjs/core';
import fetch from 'node-fetch';
import { HealthBudgetService } from './budget';
import { HealthMealService, MealItem } from './meal';
import { HealthBodyService } from './body';
import { HealthActivityService } from './activity';

interface LlmEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface RecognizeResult {
  available: boolean;
  items: MealItem[];
  totalKcal: number;
  confidence?: string;
  notes?: string;
}

/** 提取 LLM 回复中的 JSON（容忍 markdown 代码块包裹）。 */
function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('LLM 回复中未找到 JSON');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * AI 能力：拍照识别热量（vision 模型）+ 当日饮食建议（文本模型）。
 * 两者独立可选配置，未配置时优雅降级（recognize 返回 available:false，
 * advice 返回规则文案），不影响其余功能。
 */
@Provide()
export class HealthAdviceService {
  @Config('health')
  healthConfig: {
    apiToken: string;
    vision: LlmEndpoint;
    chat: LlmEndpoint;
  };

  @Inject()
  budgetService: HealthBudgetService;

  @Inject()
  mealService: HealthMealService;

  @Inject()
  bodyService: HealthBodyService;

  @Inject()
  activityService: HealthActivityService;

  private async chatCompletion(
    ep: LlmEndpoint,
    messages: any[],
    maxTokens = 1500
  ): Promise<string> {
    const res = await fetch(
      `${ep.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ep.apiKey}`,
        },
        body: JSON.stringify({
          model: ep.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
        timeout: 60000,
      } as any
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM 调用失败 ${res.status}：${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM 返回内容为空');
    return content;
  }

  /** 拍照识别：base64 图片 → 食物清单与热量/宏量估算（不落库，前端确认后再提交）。 */
  async recognize(
    imageBase64: string,
    hint?: string
  ): Promise<RecognizeResult> {
    const ep = this.healthConfig.vision;
    if (!ep?.apiKey || !ep?.model) {
      return {
        available: false,
        items: [],
        totalKcal: 0,
        notes:
          '未配置视觉模型（HEALTH_VISION_API_KEY / HEALTH_VISION_MODEL），请手动录入',
      };
    }
    if (!imageBase64) throw new Error('缺少图片数据');
    // data URI 或裸 base64 都接受
    const url = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;

    const prompt = `你是营养师。识别照片中的食物，估算每项的分量、热量(kcal)和宏量营养素(克)。
${hint ? `用户补充说明：${hint}` : ''}
只输出 JSON，不要其他文字，结构：
{"items":[{"name":"食物名","portion":"估算分量如 150g/1碗","kcal":0,"proteinG":0,"carbsG":0,"fatG":0}],"confidence":"high|medium|low","notes":"备注"}
估算误差控制在合理范围，宁可略保守（偏高）估热量。`;

    const content = await this.chatCompletion(ep, [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url } },
        ],
      },
    ]);
    const parsed = extractJson(content);
    const items: MealItem[] = (parsed.items || []).map((i: any) => ({
      name: String(i.name || '未知食物'),
      portion: String(i.portion || ''),
      kcal: Math.round(Number(i.kcal) || 0),
      proteinG: Math.round((Number(i.proteinG ?? i.protein_g) || 0) * 10) / 10,
      carbsG: Math.round((Number(i.carbsG ?? i.carbs_g) || 0) * 10) / 10,
      fatG: Math.round((Number(i.fatG ?? i.fat_g) || 0) * 10) / 10,
    }));
    return {
      available: true,
      items,
      totalKcal: items.reduce((s, i) => s + i.kcal, 0),
      confidence: parsed.confidence || 'medium',
      notes: parsed.notes || '',
    };
  }

  /** 当日建议：结合预算、今日已摄入、最新体成分与近期活动，生成接下来怎么吃。 */
  async todayAdvice(
    date: string
  ): Promise<{ source: 'ai' | 'rule'; advice: string }> {
    const [budget, day, body, activities] = await Promise.all([
      this.budgetService.current(),
      this.mealService.day(date),
      this.bodyService.latest(),
      this.activityService.list(7),
    ]);
    const remaining = budget.intakeKcal - day.summary.totalKcal;
    const remainingProtein = Math.max(
      0,
      budget.proteinG - day.summary.proteinG
    );

    const ep = this.healthConfig.chat;
    if (ep?.apiKey && ep?.model) {
      try {
        const prompt = `你是我的私人营养师。基于以下数据给出今天接下来的饮食建议（中文，200字内，具体到吃什么、大约多少量）：
- 今日预算：${budget.intakeKcal} kcal（蛋白 ${budget.proteinG}g / 碳水 ${
          budget.carbsG
        }g / 脂肪 ${budget.fatG}g），TDEE ${budget.basis.tdee}（${
          budget.basis.tdeeSource === 'measured'
            ? 'Apple Watch 实测'
            : '系数估算'
        }）
- 今日已吃 ${day.summary.mealsLogged} 餐共 ${
          day.summary.totalKcal
        } kcal（蛋白 ${
          day.summary.proteinG
        }g），剩余额度 ${remaining} kcal、蛋白缺口 ${remainingProtein}g
- 已记录餐次：${
          day.meals
            .map(
              m =>
                `${m.mealType}: ${
                  m.items.map(i => i.name).join('、') ||
                  m.notes ||
                  m.totalKcal + 'kcal'
                }`
            )
            .join('；') || '无'
        }
- 身体状况：体重 ${body?.weightKg ?? '未知'}kg，体脂率 ${
          body?.bodyFatPct ?? '未知'
        }%，内脏脂肪 ${
          body?.visceralFatLevel ?? '未知'
        }（目标：减脂保肌肉，内脏脂肪偏高优先改善）
- 近7天活动：${
          activities.length
            ? activities
                .map(a => `${a.date.slice(5)}步数${a.steps ?? '-'}`)
                .join('，')
            : '无同步数据'
        }
原则：高蛋白优先、粗粮碳水、少油炸、晚餐提前减量、不建议夜宵。若剩余额度不足 300 kcal 提醒轻食收尾。`;
        const advice = await this.chatCompletion(
          ep,
          [{ role: 'user', content: prompt }],
          600
        );
        return { source: 'ai', advice: advice.trim() };
      } catch {
        /* LLM 失败降级到规则文案 */
      }
    }

    // 规则版兜底
    const lines: string[] = [];
    lines.push(
      `今日预算 ${budget.intakeKcal} kcal，已摄入 ${day.summary.totalKcal} kcal，剩余 ${remaining} kcal。`
    );
    if (remaining <= 0) {
      lines.push(
        '今日额度已用完，接下来只喝水/无糖茶，有饥饿感可吃黄瓜、西红柿等低热量蔬菜。'
      );
    } else if (remaining < 300) {
      lines.push('剩余额度较少，建议轻食收尾：一份绿叶菜 + 鸡蛋/无糖酸奶。');
    } else {
      lines.push(
        `蛋白质还差约 ${remainingProtein} g，优先安排：鸡胸肉/鱼虾/瘦牛肉 150–200g，搭配粗粮主食一拳、蔬菜两拳。`
      );
    }
    lines.push('少油炸、晚餐尽量 19 点前吃完，饭后快走 30 分钟以上。');
    return { source: 'rule', advice: lines.join('') };
  }
}
