import { Provide, Inject, httpError } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository, Like } from 'typeorm';
import { randomUUID, createHash } from 'crypto';
import { OperationsContentEntity } from '../../entity/operationsContent';
import { OssService } from '../content/oss';
import { completeRaster } from './image';
import {
  applyCommand,
  createDocument,
  importDocument,
  Document,
  validAsset,
  STATUSES,
} from './model';

@Provide()
export class OperationsService {
  @InjectEntityModel(OperationsContentEntity)
  model: Repository<OperationsContentEntity>;
  @Inject() ossService: OssService;

  private row(
    id: string,
    document: Document,
    revision: number
  ): OperationsContentEntity {
    const latest = document.versions[document.versions.length - 1];
    return {
      id,
      document,
      title: latest.title,
      platform: latest.platform,
      status: document.status,
      revision,
      updatedAt: new Date().toISOString(),
    };
  }
  async list(query: any) {
    const where: any = {};
    if (query?.status) {
      if (!STATUSES.includes(query.status))
        throw new httpError.BadRequestError('状态错误');
      where.status = query.status;
    }
    if (query?.platform) where.platform = String(query.platform).slice(0, 40);
    if (query?.q)
      where.title = Like(
        `%${String(query.q)
          .slice(0, 200)
          .replace(/[\\%_]/g, '\\$&')}%`
      );
    const page = Math.max(1, Math.min(10000, Number(query?.page) || 1));
    const [items, total] = await this.model.findAndCount({
      where,
      select: ['id', 'title', 'platform', 'status', 'revision', 'updatedAt'],
      order: { updatedAt: 'DESC', id: 'DESC' },
      skip: (Math.floor(page) - 1) * 20,
      take: 20,
    });
    return { items, total };
  }
  async get(id: string) {
    if (typeof id !== 'string' || !/^[\w-]{36}$/.test(id))
      throw new httpError.BadRequestError('稿件 ID 错误');
    const row = await this.model.findOneBy({ id });
    if (!row) throw new httpError.NotFoundError('稿件不存在');
    const result = JSON.parse(JSON.stringify(row));
    for (const v of result.document.versions)
      for (const img of v.images)
        img.url = this.ossService.signedUrl(img.key, 1800);
    return result;
  }
  async create(input: any, actor: string) {
    const row = this.row(randomUUID(), createDocument(input, actor), 1);
    await this.model.insert(row);
    return this.get(row.id);
  }
  async command(input: any, actor: string) {
    if (typeof input?.id !== 'string' || !/^[\w-]{36}$/.test(input.id))
      throw new httpError.BadRequestError('稿件 ID 错误');
    if (!Number.isSafeInteger(input?.revision) || input.revision < 1)
      throw new httpError.BadRequestError('修订号必填');
    const old = await this.model.findOneBy({ id: input.id });
    if (!old) throw new httpError.NotFoundError('稿件不存在');
    if (old.revision !== input.revision)
      throw new httpError.ConflictError('稿件已更新，请刷新后重试；本次未覆盖');
    const document = applyCommand(old.document, input, actor);
    const row = this.row(old.id, document, old.revision + 1);
    const result = await this.model.update(
      { id: old.id, revision: old.revision },
      row
    );
    if (result.affected !== 1)
      throw new httpError.ConflictError('稿件已更新，请刷新后重试；本次未覆盖');
    return this.get(old.id);
  }
  async importContent(input: any, actor: string) {
    if (
      typeof input?.idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.idempotencyKey
      )
    )
      throw new httpError.BadRequestError('导入需提供新的 UUID idempotencyKey');
    const document = importDocument(input, actor);
    document.importHash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    const id = input.idempotencyKey;
    const existing = await this.model.findOneBy({ id });
    if (existing) {
      if (existing.document.importHash !== document.importHash)
        throw new httpError.ConflictError(
          '同一导入标识对应的素材已改变，请使用新的标识'
        );
      return this.get(id);
    }
    try {
      await this.model.insert(this.row(id, document, 1));
    } catch (e) {
      const recovered = await this.model.findOneBy({ id });
      if (!recovered || recovered.document.importHash !== document.importHash)
        throw e;
    }
    return this.get(id);
  }
  async upload(input: any) {
    const encoded = input?.dataBase64;
    if (
      typeof encoded !== 'string' ||
      encoded.length > 7 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    )
      throw new httpError.BadRequestError('图片格式错误或超过 5MB');
    const buf = Buffer.from(encoded, 'base64');
    const png =
      buf.length >= 24 &&
      buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpg =
      buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255;
    const webp =
      buf.length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP';
    const ext = png ? 'png' : jpg ? 'jpg' : webp ? 'webp' : '';
    if (!ext || buf.length > 5 * 1024 * 1024)
      throw new httpError.BadRequestError('仅支持 PNG/JPG/WebP，最大 5MB');
    if (!completeRaster(buf, ext))
      throw new httpError.BadRequestError('图片损坏或不完整，请重新导出后上传');
    const name =
      typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '';
    if (!name) throw new httpError.BadRequestError('图片名称必填');
    const key = `operations/images/${randomUUID()}.${ext}`;
    await this.ossService.putPrivate(
      key,
      buf,
      `image/${ext === 'jpg' ? 'jpeg' : ext}`
    );
    return { key, name, url: this.ossService.signedUrl(key, 1800) };
  }
  preview(key: string) {
    if (!validAsset(key)) throw new httpError.BadRequestError('图片路径错误');
    return { url: this.ossService.signedUrl(key, 1800), expiresInSec: 1800 };
  }
}
