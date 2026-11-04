import * as assert from 'assert';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  trustedClientIp,
  normalizeIp,
  clientIpFromCtx,
  clientIpFromReq,
} from '../src/common/clientIp';

/**
 * 可信客户端 IP（2026-11-04：11-03 伪造 X-Forwarded-For 刷游客 Iris 约 166 万 token）。
 * 先写的失败用例：旧写法取 XFF 第一个值，下面「伪造值不生效」三条在旧实现下全部失败。
 */
describe('trustedClientIp 只认接入层追加的最右段', () => {
  it('客户端伪造的 XFF 第一个值不生效，取接入层追加的那段', () => {
    assert.strictEqual(
      trustedClientIp('198.51.100.7, 39.144.10.2'),
      '39.144.10.2'
    );
    assert.strictEqual(
      trustedClientIp('203.0.113.1,203.0.113.2, 39.144.10.2'),
      '39.144.10.2'
    );
  });

  it('换不同的伪造值，认定的 IP 不变', () => {
    const a = trustedClientIp('198.51.100.1, 39.144.10.2');
    const b = trustedClientIp('198.51.100.2, 39.144.10.2');
    assert.strictEqual(a, b);
  });

  it('没伪造时就是唯一那段；没有 XFF 退回 socket 地址', () => {
    assert.strictEqual(trustedClientIp('39.144.10.2'), '39.144.10.2');
    assert.strictEqual(
      trustedClientIp(undefined, '::ffff:10.0.0.8'),
      '10.0.0.8'
    );
    assert.strictEqual(trustedClientIp('', ''), 'anonymous');
  });

  it('最右段塞垃圾时退回 socket 地址，不把垃圾当身份', () => {
    assert.strictEqual(
      trustedClientIp('1.1.1.1, <script>', '10.0.0.8'),
      '10.0.0.8'
    );
    assert.strictEqual(trustedClientIp('x'.repeat(500)), 'anonymous');
  });

  it('TRUSTED_PROXY_HOPS=2 时取右数第二段（前面多一层自己的代理）', () => {
    assert.strictEqual(
      trustedClientIp('198.51.100.7, 39.144.10.2, 10.1.1.1', undefined, {
        TRUSTED_PROXY_HOPS: '2',
      }),
      '39.144.10.2'
    );
  });

  it('IPv6 与带端口的写法', () => {
    assert.strictEqual(normalizeIp('2408:8207:1234::1'), '2408:8207:1234::1');
    assert.strictEqual(normalizeIp('1.2.3.4:5678'), '1.2.3.4');
    assert.strictEqual(normalizeIp('[2408::1]:443'), '2408::1');
  });

  it('ctx / req 两种入口一致', () => {
    const xff = '198.51.100.7, 39.144.10.2';
    assert.strictEqual(
      clientIpFromCtx({ headers: { 'x-forwarded-for': xff }, ip: '10.0.0.1' }),
      '39.144.10.2'
    );
    assert.strictEqual(
      clientIpFromCtx({ get: () => xff, ip: '10.0.0.1' }),
      '39.144.10.2'
    );
    assert.strictEqual(
      clientIpFromReq({
        headers: { 'x-forwarded-for': xff },
        socket: { remoteAddress: '10.0.0.1' },
      }),
      '39.144.10.2'
    );
  });
});

describe('源码扫描：不许再取 XFF 第一个值', () => {
  const root = join(__dirname, '..');
  const files: string[] = [join(root, 'server.js')];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(n)) files.push(p);
    }
  };
  walk(join(root, 'src'));
  it('除 common/clientIp.ts 外没有直接读 x-forwarded-for 的地方', () => {
    const bad = files.filter(
      f =>
        !f.endsWith(join('common', 'clientIp.ts')) &&
        /x-forwarded-for['"]\]?\)?\??\.?split|forwarded-for'\)\?\.split/i.test(
          readFileSync(f, 'utf8')
        )
    );
    const raw = files.filter(f => {
      if (f.endsWith(join('common', 'clientIp.ts')) || f.endsWith('server.js'))
        return false;
      return /['"]x-forwarded-for['"]/i.test(readFileSync(f, 'utf8'));
    });
    assert.deepStrictEqual(
      [...bad, ...raw].map(f => f.replace(root, '')),
      []
    );
  });
});
