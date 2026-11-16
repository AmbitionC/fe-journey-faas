import * as assert from 'assert';
import { sanitizeKidsLog } from '../src/service/kids/log';
import { KidsHTTPService } from '../src/function/kids';

describe('栗栗学英语 播放问题日志', () => {
  it('只留白名单字段，网页发来的 JSON 字符串也认', () => {
    const e = sanitizeKidsLog(
      JSON.stringify({ ev: 'play_rejected', ua: 'iPhone Safari', path: '/read/ort-l1-13', book: 'ort-l1-13', page: 3, name: 'NotAllowedError', src: 'l04.mp3', phone: '13800000000' }),
      1
    );
    assert.deepStrictEqual(e, { ev: 'play_rejected', ua: 'iPhone Safari', path: '/read/ort-l1-13', book: 'ort-l1-13', page: 3, name: 'NotAllowedError', src: 'l04.mp3', t: 1 });
  });

  it('事件名不对、格式不对返回 null', () => {
    assert.strictEqual(sanitizeKidsLog({ ev: 'DROP TABLE' }), null);
    assert.strictEqual(sanitizeKidsLog('not json'), null);
    assert.strictEqual(sanitizeKidsLog(null), null);
  });

  it('写进 Redis 列表并只留最近 2000 条；同一 IP 超过 60 条不再写', async () => {
    const svc = new KidsHTTPService();
    const list: string[] = [];
    let n = 0;
    (svc as any).ctx = { header: { 'x-forwarded-for': '1.2.3.4' }, headers: { 'x-forwarded-for': '1.2.3.4' }, ip: '1.2.3.4' };
    (svc as any).redisService = {
      incr: async () => ++n,
      expire: async () => 1,
      lpush: async (_k: string, v: string) => list.unshift(v),
      ltrim: async () => 'OK',
    };
    await svc.kidsLog({ ev: 'stall', ua: 'x', path: '/read/ort-l1-13' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(JSON.parse(list[0]).ev, 'stall');
    assert.strictEqual('ip' in JSON.parse(list[0]), false);
    n = 60;
    await svc.kidsLog({ ev: 'stall', ua: 'x', path: '/' });
    assert.strictEqual(list.length, 1);
  });

  it('看日志要管理员', async () => {
    const svc = new KidsHTTPService();
    (svc as any).ctx = { header: {}, headers: {} };
    (svc as any).redisService = { get: async () => null, lrange: async () => [] };
    await assert.rejects(() => svc.kidsLogList('10'));
  });

  it('IPv6 也不存进日志', async () => {
    const svc = new KidsHTTPService();
    const list: string[] = [];
    const ip6 = '240e:3a1:4c2:8d10:1d2e:3f4a:5b6c:7d8e';
    (svc as any).ctx = { header: { 'x-forwarded-for': ip6 }, headers: { 'x-forwarded-for': ip6 }, ip: ip6 };
    (svc as any).redisService = { incr: async () => 1, expire: async () => 1, lpush: async (_k: string, v: string) => list.unshift(v), ltrim: async () => 'OK' };
    await svc.kidsLog({ ev: 'play_rejected', ua: 'iPhone', path: '/read/ort-l1-13' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].includes('240e'), false);
  });
});
