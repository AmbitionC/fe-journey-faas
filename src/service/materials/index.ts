import { Provide, Inject } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { OssService } from '../content/oss';
import { NavConfigEntity } from '../../entity/navConfig';

/** OSS 上资料 PDF 的存放前缀与清单 key */
const PREFIX = 'materials/knowledge/';
const MANIFEST_KEY = `${PREFIX}manifest.json`;
/** 下载签名链接失效期：24 小时（防泄漏传播） */
const DOWNLOAD_EXPIRES = 24 * 60 * 60;

export interface MaterialItem {
  key: string;
  label: string;
  /** PDF 生成/更新时间（ISO）；未生成为 null */
  updatedAt: string | null;
  sizeBytes: number;
  articleCount: number;
  /** 是否已生成可下载的 PDF */
  ready: boolean;
}

interface Manifest {
  generatedAt?: string;
  categories?: Array<{
    key: string;
    label?: string;
    updatedAt?: string;
    sizeBytes?: number;
    articleCount?: number;
  }>;
}

/**
 * 知识点资料（按一级分类的 PDF）。
 * - PDF 由 resource 仓 CI 生成、以私有 ACL 传到 OSS `materials/knowledge/<分类>.pdf`；
 *   清单 `manifest.json` 记录每个分类的元信息。
 * - 分类全集以知识库 nav 一级节点为准（保证未生成的分类也可见），manifest 补充"已生成"状态。
 * - 下载只发 24h 签名链接（对象私有，公网直链不可达），满足失效期防泄漏诉求。
 */
@Provide()
export class MaterialsService {
  @Inject()
  ossService: OssService;

  @InjectEntityModel(NavConfigEntity)
  navModel: Repository<NavConfigEntity>;

  private pdfKey(categoryKey: string): string {
    return `${PREFIX}${categoryKey}.pdf`;
  }

  /** 读取 manifest（不存在 / 解析失败 → 空） */
  private async readManifest(): Promise<Manifest> {
    const raw = await this.ossService.getRawText(MANIFEST_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Manifest;
    } catch {
      return {};
    }
  }

  /** 知识库一级分类（key + label），作为分类全集 */
  private async firstLevelCategories(): Promise<{ key: string; label: string }[]> {
    const row = await this.navModel.findOneBy({ module: 'knowledge' });
    const nodes: any[] = Array.isArray(row?.navData) ? row!.navData : [];
    return nodes
      .filter((n) => n && n.key)
      .map((n) => ({ key: String(n.key), label: String(n.label || n.key) }));
  }

  /** 合并 nav 分类全集 + manifest 已生成状态 → 完整列表 */
  async list(): Promise<MaterialItem[]> {
    const [cats, manifest] = await Promise.all([
      this.firstLevelCategories(),
      this.readManifest(),
    ]);
    const byKey = new Map(
      (manifest.categories || []).map((c) => [c.key, c]),
    );
    return cats.map(({ key, label }) => {
      const m = byKey.get(key);
      return {
        key,
        label,
        updatedAt: m?.updatedAt || null,
        sizeBytes: m?.sizeBytes || 0,
        articleCount: m?.articleCount || 0,
        ready: !!m?.updatedAt,
      };
    });
  }

  /** 仅返回已生成、可下载的分类 */
  async listReady(): Promise<MaterialItem[]> {
    return (await this.list()).filter((i) => i.ready);
  }

  /** 某分类是否已生成 PDF */
  async isReady(categoryKey: string): Promise<boolean> {
    const manifest = await this.readManifest();
    return (manifest.categories || []).some(
      (c) => c.key === categoryKey && !!c.updatedAt,
    );
  }

  /** 生成某分类 PDF 的 24h 下载签名链接 */
  downloadUrl(categoryKey: string): string {
    return this.ossService.signedUrl(this.pdfKey(categoryKey), DOWNLOAD_EXPIRES);
  }

  /**
   * 管理端手动上传/替换某分类 PDF（应急兜底，即时覆盖 CI 产物），并更新 manifest。
   */
  async adminUpload(categoryKey: string, buf: Buffer): Promise<MaterialItem> {
    const size = await this.ossService.putPrivate(
      this.pdfKey(categoryKey),
      buf,
      'application/pdf',
    );
    // 更新 manifest：保留其它分类，覆盖本分类元信息
    const manifest = await this.readManifest();
    const cats = manifest.categories || [];
    const cat = (await this.firstLevelCategories()).find(
      (c) => c.key === categoryKey,
    );
    const now = new Date().toISOString();
    const next = cats.filter((c) => c.key !== categoryKey);
    next.push({
      key: categoryKey,
      label: cat?.label || categoryKey,
      updatedAt: now,
      sizeBytes: size,
      articleCount: 0, // 手动上传不统计文章数
    });
    await this.ossService.putRawText(
      MANIFEST_KEY,
      JSON.stringify({ generatedAt: now, categories: next }, null, 2),
    );
    return {
      key: categoryKey,
      label: cat?.label || categoryKey,
      updatedAt: now,
      sizeBytes: size,
      articleCount: 0,
      ready: true,
    };
  }
}
