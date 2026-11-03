import * as assert from 'assert';
import {
  AVATAR_DAILY_UPLOADS,
  OSS_PUBLIC_BASE,
  avatarObjectKey,
  avatarSeedOf,
  isAllowedAvatar,
  sniffImage,
} from '../src/common/avatar';
import { UserService } from '../src/service/user';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);

function makeService(user: any) {
  const svc = new UserService();
  const saved: any[] = [];
  const counters = new Map<string, number>();
  (svc as any).userModel = {
    findOneBy: async () => user,
    save: async (u: any) => saved.push({ ...u }),
  };
  (svc as any).redisService = {
    incr: async (k: string) => {
      counters.set(k, (counters.get(k) || 0) + 1);
      return counters.get(k);
    },
    expire: async () => 1,
  };
  return { svc, saved };
}

function fakeUser() {
  return { id: 42, phoneNumber: '13800000000', avatar: 'default', toVO() { return { ...this }; } };
}

describe('用户头像', () => {
  it('avatar 列只收预设标识与本站 OSS 头像', () => {
    assert.ok(isAllowedAvatar('default'));
    assert.ok(isAllowedAvatar('cat'));
    assert.ok(isAllowedAvatar('aj-07'));
    assert.ok(isAllowedAvatar(`${OSS_PUBLIC_BASE}/avatars/abc/def.webp`));
    assert.ok(!isAllowedAvatar('https://evil.example.com/a.png'));
    assert.ok(!isAllowedAvatar(`${OSS_PUBLIC_BASE}/images/x.png`));
    assert.ok(!isAllowedAvatar(`${OSS_PUBLIC_BASE}/avatars/../images/x.png`));
    assert.ok(!isAllowedAvatar('data:image/svg+xml,<svg onload=alert(1)>'));
    assert.ok(!isAllowedAvatar('Cat Dog'));
  });

  it('默认头像种子只用 id，不带手机号', () => {
    assert.strictEqual(avatarSeedOf({ id: 42 }), 'u42');
    assert.ok(!avatarSeedOf({ id: 42, phoneNumber: '138' } as any).includes('138'));
    assert.strictEqual(avatarSeedOf(null), 'journey');
  });

  it('按文件头识别类型，SVG/GIF 一律不认', () => {
    assert.strictEqual(sniffImage(PNG)?.ext, 'png');
    assert.strictEqual(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))?.ext, 'jpg');
    assert.strictEqual(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.ext, 'webp');
    assert.strictEqual(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.strictEqual(sniffImage(Buffer.from('GIF89a......')), null);
  });

  it('对象 key 不含手机号且按内容寻址', () => {
    const k = avatarObjectKey('13800000000', PNG, 'png');
    assert.ok(k.startsWith('avatars/') && k.endsWith('.png'));
    assert.ok(!k.includes('13800000000'));
    assert.strictEqual(k, avatarObjectKey('13800000000', PNG, 'png'));
  });

  it('上传成功写 OSS 并回写 avatar 与 avatarSeed', async () => {
    const user = fakeUser();
    const { svc, saved } = makeService(user);
    const puts: any[] = [];
    const oss: any = { putAvatar: async (k: string, b: Buffer, m: string) => puts.push({ k, b, m }) };
    const res = await svc.uploadAvatar('13800000000', `data:image/png;base64,${PNG.toString('base64')}`, oss);
    assert.strictEqual(puts.length, 1);
    assert.strictEqual(puts[0].m, 'image/png');
    assert.strictEqual(res.data.avatar, `${OSS_PUBLIC_BASE}/${puts[0].k}`);
    assert.strictEqual(res.data.avatarSeed, 'u42');
    assert.strictEqual(saved.length, 1);
  });

  it('非图片、超大、超频都拒收且不写库', async () => {
    const user = fakeUser();
    const { svc, saved } = makeService(user);
    const oss: any = { putAvatar: async () => undefined };
    await assert.rejects(svc.uploadAvatar('13800000000', Buffer.from('<svg/>').toString('base64'), oss));
    await assert.rejects(svc.uploadAvatar('13800000000', 'A'.repeat(800 * 1024), oss));
    await assert.rejects(svc.uploadAvatar('13800000000', '', oss));
    for (let i = 0; i < AVATAR_DAILY_UPLOADS; i++) {
      await svc.uploadAvatar('13800000000', PNG.toString('base64'), oss);
    }
    await assert.rejects(svc.uploadAvatar('13800000000', PNG.toString('base64'), oss), /次数太多/);
    assert.strictEqual(saved.length, AVATAR_DAILY_UPLOADS);
  });

  it('updateUser 拒收外链头像', async () => {
    const user = fakeUser();
    const { svc } = makeService(user);
    await assert.rejects(svc.updateUser('13800000000', { avatar: 'https://evil.example.com/a.png' }));
    const ok = await svc.updateUser('13800000000', { avatar: 'aj-03' });
    assert.strictEqual(ok.data.avatar, 'aj-03');
    const reset = await svc.updateUser('13800000000', { avatar: '' });
    assert.strictEqual(reset.data.avatar, 'default');
  });
});
