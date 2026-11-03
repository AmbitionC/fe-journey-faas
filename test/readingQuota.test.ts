import * as assert from 'assert';
import { summarizeReading, readerKind } from '../src/service/growth/readingQuota';

describe('非会员限看 N 篇影响评估', () => {
  const guest = 'a'.repeat(32);
  it('32 位十六进制是游客，手机号是登录用户', () => {
    assert.strictEqual(readerKind(guest), 'guest');
    assert.strictEqual(readerKind('13800138000'), 'login');
  });

  it('按模块×身份分桶，超额人数与被拦阅读量按额度算', () => {
    const { list, bots } = summarizeReading(
      [
        { fingerprint: guest, module: 'interview', articles: 7 },
        { fingerprint: 'b'.repeat(32), module: 'interview', articles: 5 },
        { fingerprint: '13800138000', module: 'interview', articles: 12 },
        { fingerprint: '13800138001', module: 'interview', articles: 30 },
        { fingerprint: 'c'.repeat(32), module: 'interview', articles: 9, bot: true },
      ],
      5,
      new Set(['13800138001'])
    );
    assert.strictEqual(bots, 1);
    const g = list.find((s) => s.kind === 'guest')!;
    assert.strictEqual(g.readers, 2);
    assert.strictEqual(g.overQuota, 1);
    assert.strictEqual(g.blockedReads, 2);
    assert.strictEqual(g.buckets['4-5'], 1);
    assert.strictEqual(g.buckets['6-10'], 1);
    const l = list.find((s) => s.kind === 'login')!;
    assert.strictEqual(l.readers, 1, '会员（skip）不计入');
    assert.strictEqual(l.blockedReads, 7);
  });

  it('输出里不带任何指纹或手机号', () => {
    const out = JSON.stringify(
      summarizeReading([{ fingerprint: '13800138000', module: 'knowledge', articles: 3 }], 5)
    );
    assert.ok(!out.includes('13800138000'));
  });
});
