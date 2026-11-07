import * as assert from 'assert';
import {
  DEEPSEEK_FLASH,
  resolveDeepseekModel,
  resolveLlmModel,
  resolveLlmModelFromEnv,
} from '../src/config/llmModel';

describe('config/llmModel（DeepSeek 模型名真源，2026-11-07 全部换到 V4.1 Flash）', () => {
  it('官方 4.1 Flash 模型名就是 deepseek-flash；空值缺省也是它', () => {
    assert.strictEqual(DEEPSEEK_FLASH, 'deepseek-flash');
    assert.strictEqual(resolveDeepseekModel(undefined), 'deepseek-flash');
    assert.strictEqual(resolveDeepseekModel(''), 'deepseek-flash');
    assert.strictEqual(resolveDeepseekModel('deepseek-flash'), 'deepseek-flash');
  });

  it('旧模型名（已停用 / 临时转发 / v4-pro）一律归到 Flash，并通知一次', () => {
    const seen: string[] = [];
    for (const legacy of [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'DeepSeek-V3.2',
    ]) {
      assert.strictEqual(
        resolveDeepseekModel(legacy, (from, to) => seen.push(`${from}>${to}`)),
        'deepseek-flash',
        legacy
      );
    }
    assert.deepStrictEqual(seen, [
      'deepseek-chat>deepseek-flash',
      'deepseek-reasoner>deepseek-flash',
      'deepseek-v4-flash>deepseek-flash',
      'deepseek-v4-pro>deepseek-flash',
      'DeepSeek-V3.2>deepseek-flash',
    ]);
  });

  it('未知的新模型名原样保留（给将来 V4.1 Pro 留口子）', () => {
    assert.strictEqual(resolveDeepseekModel('deepseek-v4.1-pro'), 'deepseek-v4.1-pro');
  });

  it('非 deepseek 供应商不做归一，尊重环境变量', () => {
    assert.strictEqual(resolveLlmModel('openai', 'gpt-4.1-mini'), 'gpt-4.1-mini');
    assert.strictEqual(resolveLlmModel('openai', '', 'gpt-x'), 'gpt-x');
    assert.strictEqual(resolveLlmModel('deepseek', 'deepseek-chat'), 'deepseek-flash');
  });

  it('从环境变量解析：主模型与报告模型都落到 Flash；报告模型可显式覆盖', () => {
    assert.deepStrictEqual(
      resolveLlmModelFromEnv({ LLM_MODEL: 'deepseek-v4-flash' } as NodeJS.ProcessEnv),
      { model: 'deepseek-flash', reportModel: 'deepseek-flash' }
    );
    assert.deepStrictEqual(
      resolveLlmModelFromEnv({ IRIS_REPORT_MODEL: 'deepseek-v4-pro' } as NodeJS.ProcessEnv),
      { model: 'deepseek-flash', reportModel: 'deepseek-flash' }
    );
    assert.deepStrictEqual(
      resolveLlmModelFromEnv({
        LLM_MODEL: 'deepseek-flash',
        IRIS_REPORT_MODEL: 'deepseek-v4.1-pro',
      } as NodeJS.ProcessEnv),
      { model: 'deepseek-flash', reportModel: 'deepseek-v4.1-pro' }
    );
  });
});
