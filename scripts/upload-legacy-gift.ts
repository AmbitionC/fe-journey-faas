/** 复用既有 OSS 私有上传链；不建账号、不开权限、不读取或输出凭据。 */
import { readFileSync } from 'fs';
import { MaterialsService } from '../src/service/materials';
import { OssService } from '../src/service/content/oss';
import { LEGACY_PDF_KEY, LEGACY_PDF_SHA256, LEGACY_PDF_SIZE, assertLegacyPdf } from '../src/common/legacyPdfGift';

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args[0] === '--check-only';
  const path = args[checkOnly ? 1 : 0];
  if (!path || args.length !== (checkOnly ? 2 : 1)) throw new Error('用法：ts-node scripts/upload-legacy-gift.ts [--check-only] <原版PDF路径>');
  const buf = readFileSync(path);
  assertLegacyPdf(buf);
  if (!checkOnly) {
    if (!process.env.OSS_ACCESS_KEY_ID || !process.env.OSS_ACCESS_KEY_SECRET) throw new Error('缺少现有 OSS 上传授权；未上传文件。请使用已获准的管理员资料上传会话，或现有资产发布环境。');
    const service = new MaterialsService();
    service.ossService = new OssService();
    await service.adminUpload(LEGACY_PDF_KEY, buf);
    if (!(await service.legacyGift())) throw new Error('上传后就绪校验失败，附赠尚不可领取');
  }
  console.log(JSON.stringify({ checkedOnly: checkOnly, key: LEGACY_PDF_KEY, sizeBytes: LEGACY_PDF_SIZE, sha256: LEGACY_PDF_SHA256, uploaded: !checkOnly }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
