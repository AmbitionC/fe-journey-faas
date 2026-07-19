/**
 * 离线评测 runner（PRD-02 F2-3）。
 * 与模型调用解耦：传入 callLLM(system, user) => Promise<string>，
 * 既可接真实 DeepSeek（cli.ts），也可在单测里传入 mock 验证指标聚合。
 */
import { buildGradeMessages } from '../service/ai/prompts';
import { GRADE_CASES, GradeEvalCase } from './dataset';
import { verdictMatch, aggregate, MetricSummary } from './metrics';

export type CallLLM = (system: string, user: string) => Promise<string>;

export interface EvalReport {
  gradeAccuracy: MetricSummary; // 判分档位正确率
  details: {
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
  gradeCases: GradeEvalCase[] = GRADE_CASES
): Promise<EvalReport> {
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
    gradeAccuracy: aggregate(gradeDetails.map((g) => g.match)),
    details: { grades: gradeDetails },
    generatedAt: new Date().toISOString(),
  };
}
