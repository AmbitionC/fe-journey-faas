import { randomUUID } from 'crypto';
import { httpError } from '@midwayjs/core';

export const STATUSES = [
  'draft',
  'in_review',
  'needs_changes',
  'ready',
  'published',
  'archived',
] as const;
export type Status = (typeof STATUSES)[number];
export interface Asset {
  key: string;
  name: string;
}
export interface Version {
  id: string;
  title: string;
  body: string;
  platform: string;
  images: Asset[];
  note: string;
  createdAt: string;
  actor: string;
}
export interface Publication {
  id: string;
  versionId: string;
  publishedAt: string;
  url: string | null;
  recordedAt: string;
  actor: string;
}
export interface Review {
  id: string;
  publicationId: string;
  observedAt: string;
  metrics: Record<string, number | null>;
  conclusion: string;
  nextSteps: string;
  actor: string;
  recordedAt: string;
}
export interface Document {
  versions: Version[];
  publications: Publication[];
  reviews: Review[];
  events: {
    type: string;
    versionId: string;
    status: Status;
    note: string;
    actor: string;
    at: string;
  }[];
  status: Status;
  importHash?: string;
}

function fail(message: string): never {
  throw new httpError.BadRequestError(message);
}
function text(
  value: unknown,
  label: string,
  max: number,
  required = false
): string {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') fail(`${label}格式错误`);
  const result = (value as string).trim();
  if ((required && !result) || result.length > max)
    fail(`${label}必填且不能超过 ${max} 字`);
  return result;
}
export function validAsset(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    /^operations\/images\/[a-zA-Z0-9_-]+\.(png|jpg|webp)$/.test(key)
  );
}
function version(input: any, actor: string, at: string): Version {
  if (!input || typeof input !== 'object') fail('稿件格式错误');
  const platform = text(input.platform, '平台', 40, true);
  if (!['xiaohongshu', 'wechat', 'juejin', 'other'].includes(platform))
    fail('平台不支持');
  if (!Array.isArray(input.images) || input.images.length > 20)
    fail('图片最多 20 张');
  const images = input.images.map((image: any) => {
    if (!validAsset(image?.key)) fail('图片必须为已上传的运营私有图片');
    return { key: image.key, name: text(image.name, '图片名称', 200, true) };
  });
  if (new Set(images.map(i => i.key)).size !== images.length)
    fail('图片不可重复');
  return {
    id: randomUUID(),
    title: text(input.title, '标题', 200, true),
    body: text(input.body, '正文', 30000),
    platform,
    images,
    note: text(input.note, '备注', 2000),
    createdAt: at,
    actor,
  };
}
function date(value: unknown, now: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)
  )
    fail('时间必填且格式错误');
  const result = new Date(value as string);
  if (!Number.isFinite(result.getTime()) || result.getTime() > Date.parse(now))
    fail('时间无效或晚于当前时间');
  return result.toISOString();
}
export function createDocument(
  input: any,
  actor: string,
  at = new Date().toISOString()
): Document {
  const v = version(input, actor, at);
  return {
    status: 'draft',
    versions: [v],
    publications: [],
    reviews: [],
    events: [
      {
        type: 'create',
        versionId: v.id,
        status: 'draft',
        note: v.note,
        actor,
        at,
      },
    ],
  };
}
export function applyCommand(
  current: Document,
  command: any,
  actor: string,
  at = new Date().toISOString()
): Document {
  if (!command || typeof command !== 'object') fail('操作格式错误');
  const doc: Document = JSON.parse(JSON.stringify(current));
  const note = text(command.note, '备注', 2000);
  let v = doc.versions[doc.versions.length - 1];
  let eventVersionId = v.id;
  if (command.type === 'save') {
    v = version(command, actor, at);
    doc.versions.push(v);
    eventVersionId = v.id;
    // Every content/image edit starts a new draft; old approval and publication stay bound to old version.
    doc.status = 'draft';
  } else if (command.type === 'status') {
    if (!STATUSES.includes(command.status) || command.status === 'published')
      fail('状态错误；已发布请使用手动标记发布');
    doc.status = command.status;
  } else if (command.type === 'publish') {
    if (doc.publications.some(p => p.versionId === v.id))
      fail('当前版本已经标记发布，请先保存新版本');
    const publishedAt = date(command.publishedAt, at);
    const url = text(command.url, '发布链接', 2000) || null;
    if (url) {
      try {
        const u = new URL(url);
        if (
          !['http:', 'https:'].includes(u.protocol) ||
          u.username ||
          u.password
        )
          fail('发布链接必须为 http/https 地址');
      } catch {
        fail('发布链接必须为 http/https 地址');
      }
    }
    doc.publications.push({
      id: randomUUID(),
      versionId: v.id,
      publishedAt,
      url,
      actor,
      recordedAt: at,
    });
    doc.status = 'published';
  } else if (command.type === 'review') {
    const publication = doc.publications.find(
      p => p.id === command.publicationId
    );
    if (!publication) fail('请选择已发布记录');
    eventVersionId = publication.versionId;
    const observedAt = date(command.observedAt, at);
    if (Date.parse(observedAt) < Date.parse(publication.publishedAt))
      fail('观察时间不能早于发布时间');
    const metrics: Record<string, number | null> = {};
    for (const key of ['views', 'likes', 'saves', 'comments']) {
      const value = command[key];
      if (value === null || value === undefined || value === '')
        metrics[key] = null;
      else if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        metrics[key] = value;
      else fail('指标必须为非负整数，未知请留空');
    }
    doc.reviews.push({
      id: randomUUID(),
      publicationId: publication.id,
      observedAt,
      metrics,
      conclusion: text(command.conclusion, '结论', 5000),
      nextSteps: text(command.nextSteps, '下次改进', 5000),
      actor,
      recordedAt: at,
    });
  } else fail('不支持的操作');
  if (doc.versions.length > 300 || doc.events.length >= 2000)
    fail('记录数量超过上限，请拆分稿件');
  doc.events.push({
    type: command.type,
    versionId: eventVersionId,
    status: doc.status,
    note,
    actor,
    at,
  });
  return doc;
}

/** Unpublished imports only. Each version owns its images and review status independently. */
export function importDocument(
  input: any,
  actor: string,
  at = new Date().toISOString()
): Document {
  if (
    !Array.isArray(input?.versions) ||
    !input.versions.length ||
    input.versions.length > 50
  )
    fail('导入需包含 1–50 个版本');
  if (input.publications?.length || input.reviews?.length)
    fail('此导入仅接收未发布稿件');
  let doc: Document;
  for (const [index, item] of input.versions.entries()) {
    if (!STATUSES.includes(item?.status) || item.status === 'published')
      fail('导入状态错误，不能导入已发布记录');
    doc =
      index === 0
        ? createDocument(item, actor, at)
        : applyCommand(doc!, { ...item, type: 'save' }, actor, at);
    doc = applyCommand(
      doc,
      { type: 'status', status: item.status, note: item.note },
      actor,
      at
    );
  }
  return doc!;
}
