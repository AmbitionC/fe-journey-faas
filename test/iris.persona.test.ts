import * as assert from 'assert';
import { IRIS_SOUL, buildModulePersona } from '../src/service/ai/proxy';

describe('Iris 人设', () => {
  it('IRIS_SOUL 含核心准则', () => {
    assert.ok(IRIS_SOUL.includes('Iris'));
    assert.ok(/引导|苏格拉底|提示/.test(IRIS_SOUL));
    assert.ok(/诚实|不编造|不夸大/.test(IRIS_SOUL));
  });
  it('algorithm 专长含"不直接给答案"语义', () => {
    const p = buildModulePersona('algorithm');
    assert.ok(p.startsWith(IRIS_SOUL));
    assert.ok(/提示|不直接/.test(p));
  });
  it('未知模块回退默认专长且含 IRIS_SOUL', () => {
    assert.ok(buildModulePersona('zzz').startsWith(IRIS_SOUL));
    assert.ok(buildModulePersona('zzz').includes('全栈'));
  });
});
