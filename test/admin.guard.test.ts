import * as assert from 'assert';
import { assertAdmin } from '../src/common/admin.guard';

describe('assertAdmin', () => {
  it('admin 角色应通过（不抛错）', () => {
    assert.doesNotThrow(() => assertAdmin({ userInfo: { role: 'admin' } }));
  });

  it('普通 user 角色应被拒（抛 401）', () => {
    assert.throws(
      () => assertAdmin({ userInfo: { role: 'user' } }),
      (err: any) => {
        assert.strictEqual(err.status, 401);
        assert.ok(/管理员/.test(err.message));
        return true;
      }
    );
  });

  it('userInfo 为 undefined 应被拒（抛 401）', () => {
    assert.throws(
      () => assertAdmin({}),
      (err: any) => {
        assert.strictEqual(err.status, 401);
        return true;
      }
    );
  });

  it('role 缺失（undefined）应被拒（抛 401）', () => {
    assert.throws(
      () => assertAdmin({ userInfo: {} }),
      (err: any) => {
        assert.strictEqual(err.status, 401);
        return true;
      }
    );
  });
});
