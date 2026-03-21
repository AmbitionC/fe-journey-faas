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
  passed: boolean;
  runtime: number | null;
  memory: number | null;
  error: string | null;
}

@Provide()
export class Judge0Service {
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

  async executeCode(
    code: string,
    language: string,
    stdin: string,
    expectedOutput: string
  ): Promise<TestCaseResult> {
    const languageId = this.getLanguageId(language);

    const response = await fetch(
      `${this.judge0Config.apiUrl}/submissions?base64_encoded=true&wait=true`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RapidAPI-Key': this.judge0Config.apiKey,
          'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com',
        },
        body: JSON.stringify({
          language_id: languageId,
          source_code: Buffer.from(code).toString('base64'),
          stdin: Buffer.from(stdin).toString('base64'),
          expected_output: Buffer.from(expectedOutput).toString('base64'),
          cpu_time_limit: this.judge0Config.timeout,
          memory_limit: this.judge0Config.memoryLimit,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Judge0 API error: ${response.status}`);
    }

    const result: Judge0Result = await response.json();

    const actualOutput = result.stdout
      ? Buffer.from(result.stdout, 'base64').toString().trim()
      : '';
    const error = result.stderr
      ? Buffer.from(result.stderr, 'base64').toString()
      : result.compile_output
      ? Buffer.from(result.compile_output, 'base64').toString()
      : null;

    return {
      input: stdin,
      expectedOutput: expectedOutput.trim(),
      actualOutput,
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
