/**
 * 调用隔离运行函数 iris-code-runner（runner/code-runner，见 s.yaml irisCodeRunner）。
 * Iris 的 run_code 工具和作业评审 Agent 共用。地址 / 令牌由 deploy.yml 部署运行函数后注入。
 */
export function codeRunnerConfigured(): boolean {
  return !!(process.env.CODE_RUNNER_URL && process.env.CODE_RUNNER_TOKEN);
}

export interface RunRequest {
  language?: 'javascript' | 'typescript';
  code: string;
  stdin?: string;
  files?: Record<string, string>;
  timeoutMs?: number;
}

/** 返回运行器的原始结果；HTTP 非 2xx 或网络失败抛错。 */
export async function callCodeRunner(req: RunRequest, timeoutMs = 25000): Promise<any> {
  if (!codeRunnerConfigured()) throw new Error('代码运行环境未配置');
  const url = String(process.env.CODE_RUNNER_URL).replace(/\/+$/, '') + '/run';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-runner-token': String(process.env.CODE_RUNNER_TOKEN) },
    body: JSON.stringify({ timeoutMs: 8000, ...req, language: req.language === 'typescript' ? 'typescript' : 'javascript' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`运行环境返回 ${resp.status}`);
  return resp.json();
}
