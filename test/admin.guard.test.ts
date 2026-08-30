import * as assert from 'assert';
import { assertAdmin } from '../src/common/admin.guard';

/**
 * 2026-08-30 修正：assertAdmin 是 async 函数，旧写法 `assert.throws(() => assertAdmin(...))`
 * 对 async 永远捕不到异常（返回 rejected promise 而非同步抛）——三个「应被拒」用例
 * 从未真正生效，直到 npm test 全量入口修复（二次验收 P3-5）后才在 CI 现形。
 * async 断言必须用 assert.rejects / assert.doesNotReject。
 * fixture 须带 userId——resolveUserInfo 快路径按 userId 判登录态完整性（生产
 * ctx.userInfo 来自 auth 中间件、恒含 userId），缺它会走 Redis 反查再落 null。
 */
describe('assertAdmin', () => {
  it('admin 角色应通过（不抛错）', async () => {
    await assert.doesNotReject(assertAdmin({ userInfo: { userId: 'u1', role: 'admin' } } as any));
  });

  it('普通 user 角色应被拒（抛 401）', async () => {
    await assert.rejects(
      assertAdmin({ userInfo: { userId: 'u2', role: 'user' } } as any),
      (err: any) => {
        assert.strictEqual(err.status, 401);
        assert.ok(/管理员/.test(err.message));
        return true;
      },
    );
  });

  it('userInfo 为 undefined 应被拒（抛 401）', async () => {
    await assert.rejects(
      assertAdmin({} as any),
      (err: any) => {
        assert.strictEqual(err.status, 401);
        return true;
      },
    );
  });

  it('role 缺失（undefined）应被拒（抛 401）', async () => {
    await assert.rejects(
      assertAdmin({ userInfo: {} } as any),
      (err: any) => {
        assert.strictEqual(err.status, 401);
        return true;
      },
    );
  });
});
