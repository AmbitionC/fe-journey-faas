import { Config, Provide } from '@midwayjs/core';
import fetch from 'node-fetch';

const LANGUAGE_MAP: Record<string, number> = {
  javascript: 63,
  typescript: 74,
  python: 71,
  c: 50,
  cpp: 54,
  java: 62,
};

const EXPLICIT_INPUT_HANDLING_PATTERN =
  /\/dev\/stdin|process\.stdin|readFileSync\s*\(\s*(?:0|['"]\/dev\/stdin['"])\s*[\),]/;
const FINAL_RESULT_SENTINEL = '__ALGORITHM_RESULT__:';

function normalizeText(value: string | null | undefined) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function normalizeDisplayText(value: string | null | undefined) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

function extractExecutionOutput(stdout: string | null | undefined) {
  const decoded = String(stdout ?? '').replace(/\r\n/g, '\n');
  const lines = decoded.split('\n');
  const debugLines: string[] = [];
  let hasFinalResult = false;
  let actualOutput = '';

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith(FINAL_RESULT_SENTINEL)) {
      try {
        const payload = JSON.parse(line.slice(FINAL_RESULT_SENTINEL.length));
        actualOutput = normalizeText(payload?.value);
        hasFinalResult = true;
        continue;
      } catch {
        debugLines.push(line);
        continue;
      }
    }

    debugLines.push(line);
  }

  return {
    hasFinalResult,
    actualOutput: hasFinalResult ? actualOutput : normalizeText(decoded),
    debugOutput: hasFinalResult
      ? normalizeDisplayText(debugLines.join('\n')) || null
      : null,
  };
}

const FUNCTION_MODE_RUNNER_SOURCE = String.raw`
const __algorithmParseInputValue = line => {
  const text = String(line == null ? '' : line).trim();
  if (text === '') return '';
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (text === 'undefined') return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const __algorithmBacktick = String.fromCharCode(96);

  if (
    (text.startsWith('[') && text.endsWith(']')) ||
    (text.startsWith('{') && text.endsWith('}')) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    try {
      return JSON.parse(text);
    } catch {}
  }

  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith(__algorithmBacktick) && text.endsWith(__algorithmBacktick))
  ) {
    return text.slice(1, -1);
  }

  return text;
};

const __algorithmSerialize = value => {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return 'undefined';

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const __algorithmResolve = expression => {
  try {
    return eval(expression);
  } catch {
    return undefined;
  }
};

const __algorithmRunClassStyle = args => {
  if (
    args.length !== 2 ||
    !Array.isArray(args[0]) ||
    !Array.isArray(args[1]) ||
    !args[0].length ||
    args[0].length !== args[1].length
  ) {
    return { matched: false };
  }

  const operations = args[0];
  const params = args[1];

  if (
    !operations.every(item => typeof item === 'string') ||
    !params.every(item => Array.isArray(item))
  ) {
    return { matched: false };
  }

  const constructorName = operations[0];
  const Constructor = __algorithmResolve(
    'typeof ' + constructorName + ' !== "undefined" ? ' + constructorName + ' : undefined'
  );

  if (typeof Constructor !== 'function') {
    return { matched: false };
  }

  const instance = new Constructor(...params[0]);
  const outputs = [null];

  for (let index = 1; index < operations.length; index += 1) {
    const methodName = operations[index];
    const method = instance?.[methodName];

    if (typeof method !== 'function') {
      throw new Error('Method "' + methodName + '" is not defined');
    }

    const result = method.apply(instance, params[index]);
    outputs.push(result === undefined ? null : result);
  }

  return { matched: true, value: outputs };
};

const __algorithmInput = require('fs')
  .readFileSync('/dev/stdin', 'utf8')
  .replace(/\r\n/g, '\n');

const __algorithmLines =
  __algorithmInput === '' ? [] : __algorithmInput.split('\n');

if (
  __algorithmLines.length > 0 &&
  __algorithmLines[__algorithmLines.length - 1] === ''
) {
  __algorithmLines.pop();
}

const __algorithmArgs = __algorithmLines.map(__algorithmParseInputValue);
const __algorithmSolution = __algorithmResolve(
  'typeof solution !== "undefined" ? solution : undefined'
);

if (typeof __algorithmSolution === 'function') {
  const __algorithmResult = __algorithmSolution(...__algorithmArgs);
  console.log('${FINAL_RESULT_SENTINEL}' + JSON.stringify({
    value:
      typeof __algorithmResult === 'undefined'
        ? ''
        : __algorithmSerialize(__algorithmResult)
  }));
} else {
  const __algorithmClassResult = __algorithmRunClassStyle(__algorithmArgs);
  if (__algorithmClassResult.matched) {
    console.log('${FINAL_RESULT_SENTINEL}' + JSON.stringify({
      value: __algorithmSerialize(__algorithmClassResult.value)
    }));
  } else {
    throw new Error('请定义 solution 函数，或实现题目要求的类');
  }
}
`;

export interface Judge0Result {
  stdout: string | null;
  stderr: string | null;
  compile_output: string | null;
  status: { id: number; description: string };
  time: string | null;
  memory: number | null;
}

export interface TestCaseResult {
  input: string;
  expectedOutput: string;
  actualOutput: string;
  debugOutput?: string | null;
  passed: boolean;
  runtime: number | null;
  memory: number | null;
  error: string | null;
}

@Provide()
export class Judge0ClientService {
  @Config('judge0')
  judge0Config: {
    apiUrl: string;
    apiKey: string;
    timeout: number;
    memoryLimit: number;
  };

  getLanguageId(language: string): number {
    const id = LANGUAGE_MAP[language];
    if (!id) throw new Error(`Unsupported language: ${language}`);
    return id;
  }

  private get isRapidApi() {
    return this.judge0Config.apiUrl.includes('rapidapi.com');
  }

  private validateJudge0Config() {
    if (this.isRapidApi) {
      if (
        !this.judge0Config?.apiKey ||
        this.judge0Config.apiKey === 'YOUR_RAPIDAPI_KEY'
      ) {
        throw new Error('判题服务尚未配置完成，请联系管理员');
      }
    }
  }

  private shouldWrapFunctionMode(language: string, code: string) {
    return (
      (language === 'javascript' || language === 'typescript') &&
      !EXPLICIT_INPUT_HANDLING_PATTERN.test(code)
    );
  }

  private buildExecutableCode(code: string, language: string) {
    if (!this.shouldWrapFunctionMode(language, code)) {
      return code;
    }

    return `${code}\n\n${FUNCTION_MODE_RUNNER_SOURCE}`;
  }

  async executeCode(
    code: string,
    language: string,
    stdin: string,
    expectedOutput: string
  ): Promise<TestCaseResult> {
    const languageId = this.getLanguageId(language);
    const executableCode = this.buildExecutableCode(code, language);
    this.validateJudge0Config();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.isRapidApi) {
      headers['X-RapidAPI-Key'] = this.judge0Config.apiKey;
      headers['X-RapidAPI-Host'] = 'judge0-ce.p.rapidapi.com';
    } else if (this.judge0Config.apiKey) {
      headers['X-Auth-Token'] = this.judge0Config.apiKey;
    }

    const response = await fetch(
      `${this.judge0Config.apiUrl}/submissions?base64_encoded=true&wait=true`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: languageId,
          source_code: Buffer.from(executableCode).toString('base64'),
          stdin: Buffer.from(stdin).toString('base64'),
          expected_output: Buffer.from(expectedOutput).toString('base64'),
          cpu_time_limit: this.judge0Config.timeout,
          memory_limit: this.judge0Config.memoryLimit,
        }),
      }
    );

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {}
      const hint =
        response.status === 403
          ? '（API Key 无效或已过期，请检查 Judge0 配置）'
          : '';
      throw new Error(
        `判题服务异常 (${response.status})${hint}${detail ? ': ' + detail : ''}`
      );
    }

    const result: Judge0Result = await response.json();
    const stdoutText = result.stdout
      ? Buffer.from(result.stdout, 'base64').toString()
      : '';
    const parsedOutput = extractExecutionOutput(stdoutText);
    const error = result.stderr
      ? Buffer.from(result.stderr, 'base64').toString()
      : result.compile_output
      ? Buffer.from(result.compile_output, 'base64').toString()
      : null;
    const actualOutput =
      error && !parsedOutput.hasFinalResult ? '' : parsedOutput.actualOutput;

    return {
      input: stdin,
      expectedOutput: expectedOutput.trim(),
      actualOutput,
      debugOutput: parsedOutput.debugOutput,
      passed: result.status.id === 3, // 3 = Accepted
      runtime: result.time ? parseFloat(result.time) * 1000 : null,
      memory: result.memory,
      error,
    };
  }

  async runTestCases(
    code: string,
    language: string,
    testCases: Array<{ input: string; expectedOutput: string }>
  ): Promise<{
    allPassed: boolean;
    results: TestCaseResult[];
    totalRuntime: number;
    maxMemory: number;
  }> {
    const results: TestCaseResult[] = [];
    let totalRuntime = 0;
    let maxMemory = 0;

    for (const tc of testCases) {
      const result = await this.executeCode(
        code,
        language,
        tc.input,
        tc.expectedOutput
      );
      results.push(result);
      if (result.runtime) totalRuntime += result.runtime;
      if (result.memory && result.memory > maxMemory) maxMemory = result.memory;

      if (!result.passed && result.error) break;
    }

    return {
      allPassed: results.every(r => r.passed),
      results,
      totalRuntime: Math.round(totalRuntime),
      maxMemory,
    };
  }
}
