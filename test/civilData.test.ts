import * as assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { CivilHTTPService } from '../src/function/civil';
import { ASSET_DIR, CIVIL_DATASETS, isCivilDatasetName, loadCivilDataset, versionOf } from '../src/service/civil/staticData';

function fakeCtx(acceptEncoding = 'gzip, deflate, br') {
  const headers: Record<string, string> = {};
  return {
    status: 200,
    headers,
    set(k: string, v: string) { headers[k] = v; },
    get(k: string) { return k === 'accept-encoding' ? acceptEncoding : ''; },
  };
}

describe('考公职位表数据的杭州镜像（2026-11-11）', () => {
  it('镜像文件随代码部署：assets/civil 下两份都在，解得开且是职位表 / 进面分', () => {
    assert.ok(ASSET_DIR.endsWith(resolve('assets/civil')));
    for (const file of Object.values(CIVIL_DATASETS)) assert.ok(existsSync(resolve(ASSET_DIR, file)), file);
    const positions = JSON.parse(loadCivilDataset('positions').raw.toString('utf8'));
    assert.strictEqual(positions.total.positions, 19426);
    assert.strictEqual(positions.total.people, 35691);
    const scores = JSON.parse(loadCivilDataset('scores').raw.toString('utf8'));
    assert.ok(Array.isArray(scores.years) && scores.years.length > 0);
  });

  it('前端仓在旁边时，镜像必须与前端原文件一致（防忘同步）', function () {
    const fe = resolve(__dirname, '../../front-end-journey/public/data/civil');
    if (!existsSync(fe)) this.skip();
    assert.strictEqual(loadCivilDataset('positions').version, versionOf(readFileSync(resolve(fe, 'guokao-2027.json'))));
    assert.strictEqual(loadCivilDataset('scores').version, versionOf(readFileSync(resolve(fe, 'guokao-scores.json'))));
  });

  it('只认两个数据集名', () => {
    assert.strictEqual(isCivilDatasetName('positions'), true);
    assert.strictEqual(isCivilDatasetName('scores'), true);
    assert.strictEqual(isCivilDatasetName('toString'), false);
    assert.strictEqual(isCivilDatasetName('../x'), false);
    assert.strictEqual(isCivilDatasetName(undefined), false);
  });

  it('版本对上：发预压缩体并允许长缓存；不支持 gzip 时发明文', async () => {
    const svc = new CivilHTTPService();
    const ds = loadCivilDataset('positions');
    const ctx = fakeCtx();
    svc.ctx = ctx as any;
    const body = await svc.data('positions', ds.version);
    assert.strictEqual(body, ds.gz);
    assert.strictEqual(ctx.headers['Content-Encoding'], 'gzip');
    assert.match(ctx.headers['Cache-Control'], /immutable/);

    const plain = fakeCtx('br');
    svc.ctx = plain as any;
    assert.strictEqual(await svc.data('positions', ds.version), ds.raw);
    assert.strictEqual(plain.headers['Content-Encoding'], undefined);
  });

  it('版本对不上回 409，不下发旧数据；未知名字 404', async () => {
    const svc = new CivilHTTPService();
    const ctx = fakeCtx();
    svc.ctx = ctx as any;
    const res: any = await svc.data('scores', '000000000000');
    assert.strictEqual(ctx.status, 409);
    assert.strictEqual(res.success, false);
    assert.strictEqual(ctx.headers['Content-Encoding'], undefined);

    const ctx2 = fakeCtx();
    svc.ctx = ctx2 as any;
    await svc.data('nope');
    assert.strictEqual(ctx2.status, 404);
  });
});
