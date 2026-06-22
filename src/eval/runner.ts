/**
 * 离线评测 runner（PRD-02 F2-3）。
 * 与模型调用解耦：传入 callLLM(system, user) => Promise<string>，
 * 既可接真实 DeepSeek（cli.ts），也可在单测里传入 mock 验证指标聚合。
 */
import { buildHintPrompt, buildGradeMessages } from '../service/ai/prompts';
import { HINT_CASES, GRADE_CASES, HintEvalCase, GradeEvalCase } from './dataset';
import { isHintSpoiler, verdictMatch, aggregate, MetricSummary } from './metrics';

export type CallLLM = (system: string, user: string) => Promise<string>;

export interface EvalReport {
  spoiler: MetricSummary; // 剧透「不发生」的通过率（越高越好）
  gradeAccuracy: MetricSummary; // 判分档位正确率
  details: {
    hints: { id: string; spoiled: boolean }[];
    grades: { id: string; actual: string; expected: string; match: boolean }[];
  };
  generatedAt: string;
}

function parseJsonLoose(text: string): any {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try {
    return JSON.parse(cleaned.slice(s, e + 1));
  } catch {
    return null;
  }
}

export async function runEval(
  callLLM: CallLLM,
  hintCases: HintEvalCase[] = HINT_CASES,
  gradeCases: GradeEvalCase[] = GRADE_CASES
): Promise<EvalReport> {
  // 提示剧透评测：不剧透 = 通过
  const hintDetails: { id: string; spoiled: boolean }[] = [];
  for (const c of hintCases) {
    const { system, user } = buildHintPrompt({
      title: c.title,
      description: c.description,
      level: c.level,
    });
    let out = '';
    try {
      out = await callLLM(system, user);
    } catch {
      out = '';
    }
    hintDetails.push({ id: c.id, spoiled: isHintSpoiler(out, c.answerKeywords) });
  }

  // 判分正确性评测
  const gradeDetails: { id: string; actual: string; expected: string; match: boolean }[] = [];
  for (const c of gradeCases) {
    const { system, user } = buildGradeMessages({
      items: [{ stem: c.stem, keyPoints: c.keyPoints, userAnswer: c.userAnswer }],
      member: false,
    });
    let actual = '';
    try {
      const out = await callLLM(system, user);
      const parsed = parseJsonLoose(out);
      actual = parsed?.itemVerdicts?.[0]?.verdict || '';
    } catch {
      actual = '';
    }
    gradeDetails.push({
      id: c.id,
      actual,
      expected: c.expectedVerdict,
      match: verdictMatch(actual, c.expectedVerdict),
    });
  }

  return {
    spoiler: aggregate(hintDetails.map((h) => !h.spoiled)),
    gradeAccuracy: aggregate(gradeDetails.map((g) => g.match)),
    details: { hints: hintDetails, grades: gradeDetails },
    generatedAt: new Date().toISOString(),
  };
}
