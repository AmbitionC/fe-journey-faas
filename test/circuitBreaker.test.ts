import * as assert from 'assert';
import { nextBreaker } from '../src/service/ops/circuitBreaker';

const WIN = 60000;
const NOW = 1_700_000_000_000;

describe('ops/circuitBreaker.ts', () => {
  it('首次动作允许', () => {
    const r = nextBreaker(null, NOW, WIN, 3);
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.state.count, 1);
    assert.strictEqual(r.remaining, 2);
  });

  it('窗口内累加', () => {
    let s = nextBreaker(null, NOW, WIN, 3).state;
    s = nextBreaker(s, NOW + 1000, WIN, 3).state;
    const r = nextBreaker(s, NOW + 2000, WIN, 3);
    assert.strictEqual(r.state.count, 3);
    assert.strictEqual(r.allowed, true);
  });

  it('超阈值熔断', () => {
    let s = nextBreaker(null, NOW, WIN, 3).state;
    s = nextBreaker(s, NOW + 1, WIN, 3).state;
    s = nextBreaker(s, NOW + 2, WIN, 3).state;
    const r = nextBreaker(s, NOW + 3, WIN, 3);
    assert.strictEqual(r.tripped, true);
    assert.strictEqual(r.allowed, false);
  });

  it('窗口过期重置', () => {
    let s = nextBreaker(null, NOW, WIN, 3).state;
    s = nextBreaker(s, NOW + 1, WIN, 3).state;
    s = nextBreaker(s, NOW + 2, WIN, 3).state;
    // 超过窗口后重置
    const r = nextBreaker(s, NOW + WIN + 1, WIN, 3);
    assert.strictEqual(r.state.count, 1);
    assert.strictEqual(r.allowed, true);
  });
});
