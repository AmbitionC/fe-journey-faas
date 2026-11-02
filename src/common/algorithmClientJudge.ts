/**
 * 判题服务（Judge0）没配置时的兜底：JavaScript / TypeScript 在用户浏览器里跑，
 * 服务端只拿浏览器回传的实际输出，对照库里的期望输出重新判一遍对错。
 *
 * 局限（如实说明）：输出由浏览器回传，懂行的人可以伪造；只影响他自己的提交记录
 * 和题目的通过率统计，不涉及点数或钱。接上 Judge0 后自动回到服务端判题。
 */

export const CLIENT_JUDGE_LANGUAGES = ['javascript', 'typescript'];

export const CLIENT_JUDGE_UNSUPPORTED_MESSAGE =
  '目前在线运行与提交只支持 JavaScript / TypeScript，其他语言稍后开放';

export interface ClientCaseResult {
  actualOutput?: string;
  runtime?: number;
  error?: string | null;
}

export interface StoredCase {
  input: string;
  expectedOutput: string;
}

const normalize = (text: unknown) =>
  String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim();

export function supportsClientJudge(language: string) {
  return CLIENT_JUDGE_LANGUAGES.includes(language);
}

/**
 * 按库里的用例逐条判。回传条数对不上就整体拒绝，避免少传几条混过去。
 */
export function gradeClientResults(
  cases: StoredCase[],
  clientResults: ClientCaseResult[]
) {
  if (!Array.isArray(clientResults) || clientResults.length !== cases.length) {
    throw new Error('判题结果与用例数量不一致，请刷新页面后重试');
  }

  const results = cases.map((tc, i) => {
    const r = clientResults[i] || {};
    const error = r.error ? String(r.error).slice(0, 2000) : null;
    const actualOutput = String(r.actualOutput ?? '').slice(0, 10000);
    const runtime = Number.isFinite(Number(r.runtime))
      ? Math.max(0, Math.round(Number(r.runtime)))
      : 0;
    return {
      input: tc.input,
      expectedOutput: tc.expectedOutput,
      actualOutput,
      passed:
        !error && normalize(actualOutput) === normalize(tc.expectedOutput),
      runtime,
      memory: 0,
      error,
    };
  });

  const allPassed = results.every(r => r.passed);
  let status = 'accepted';
  if (!allPassed) {
    const failed = results.find(r => !r.passed);
    status = failed?.error ? 'runtime_error' : 'wrong_answer';
  }

  return {
    results,
    allPassed,
    status,
    totalRuntime: results.reduce((s, r) => s + r.runtime, 0),
    maxMemory: 0,
  };
}
