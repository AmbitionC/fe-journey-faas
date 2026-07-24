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

/** 单个可下载资料（对应知识库二级分类的 PDF） */
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

/** 一级分类分组（目录结构：一级 → 二级 PDF 列表） */
export interface MaterialGroup {
  key: string;
  label: string;
  items: MaterialItem[];
}

interface ManifestItem {
  key: string;
  label?: string;
  updatedAt?: string;
  sizeBytes?: number;
  articleCount?: number;
}

interface Manifest {
  generatedAt?: string;
  version?: number;
  /** v2：按一级分类分组 */
  groups?: Array<{ key: string; label?: string; items?: ManifestItem[] }>;
  /** v1（兼容旧格式）：扁平的一级分类清单 */
  categories?: ManifestItem[];
}

/**
 * 知识点资料（按知识库二级分类的 PDF）。
 * - PDF 由 resource 仓 CI 生成、以私有 ACL 传到 OSS `materials/knowledge/<二级key>.pdf`；
 *   清单 `manifest.json`（v2）按一级分类分组记录每个二级分类的元信息。
 * - 分类全集以知识库 nav（一级→二级子节点）为准（保证未生成的也可见），manifest 补充"已生成"状态。
 * - 下载只发 24h 签名链接（对象私有，公网直链不可达），满足失效期防泄漏诉求。
 */
@Provide()
export class MaterialsService {
  @Inject()
  ossService: OssService;

  @InjectEntityModel(NavConfigEntity)
  navModel: Repository<NavConfigEntity>;

  private pdfKey(itemKey: string): string {
    return `${PREFIX}${itemKey}.pdf`;
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

  /** manifest 扁平化：itemKey → 元信息（兼容 v2 groups 与 v1 categories） */
  private manifestItemMap(m: Manifest): Map<string, ManifestItem> {
    const map = new Map<string, ManifestItem>();
    if (Array.isArray(m.groups)) {
      for (const g of m.groups) {
        for (const it of g.items || []) map.set(it.key, it);
      }
    }
    for (const it of m.categories || []) map.set(it.key, it);
    return map;
  }

  /** 知识库一级→二级分类骨架（作为分类全集） */
  private async navGroups(): Promise<
    { key: string; label: string; children: { key: string; label: string }[] }[]
  > {
    const row = await this.navModel.findOneBy({ module: 'knowledge' });
    const nodes: any[] = Array.isArray(row?.navData) ? row!.navData : [];
    return nodes
      .filter((n) => n && n.key)
      .map((n) => ({
        key: String(n.key),
        label: String(n.label || n.key),
        children: (Array.isArray(n.children) ? n.children : [])
          .filter((c: any) => c && c.key)
          .map((c: any) => ({ key: String(c.key), label: String(c.label || c.key) })),
      }));
  }

  /** 合并 nav 分类骨架 + manifest 已生成状态 → 分组列表（含未生成的） */
  async groupedList(): Promise<MaterialGroup[]> {
    const [groups, manifest] = await Promise.all([
      this.navGroups(),
      this.readManifest(),
    ]);
    const byKey = this.manifestItemMap(manifest);

    const build = (child: { key: string; label: string }): MaterialItem => {
      const m = byKey.get(child.key);
      return {
        key: child.key,
        label: child.label,
        updatedAt: m?.updatedAt || null,
        sizeBytes: m?.sizeBytes || 0,
        articleCount: m?.articleCount || 0,
        ready: !!m?.updatedAt,
      };
    };

    // nav 无二级子节点时（形态异常）回退到 manifest 分组，避免整页空白
    if (groups.every((g) => g.children.length === 0) && manifest.groups?.length) {
      return manifest.groups.map((g) => ({
        key: g.key,
        label: g.label || g.key,
        items: (g.items || []).map((it) => ({
          key: it.key,
          label: it.label || it.key,
          updatedAt: it.updatedAt || null,
          sizeBytes: it.sizeBytes || 0,
          articleCount: it.articleCount || 0,
          ready: !!it.updatedAt,
        })),
      }));
    }

    return groups.map((g) => ({
      key: g.key,
      label: g.label,
      items: g.children.map(build),
    }));
  }

  /**
   * 会员下载用：仅返回已生成 PDF 的分组。
   * 以 **manifest 为准**（manifest 本身就带完整目录结构，且只含已生成项）——
   * 不依赖 nav_config 的二级 key 与 manifest 精确匹配，避免键不一致时整页空白。
   * 仅当没有 v2 manifest.groups 时才回退到 nav∩manifest 合并逻辑。
   */
  async groupedListReady(): Promise<MaterialGroup[]> {
    const manifest = await this.readManifest();
    if (Array.isArray(manifest.groups) && manifest.groups.length) {
      return manifest.groups
        .map((g) => ({
          key: g.key,
          label: g.label || g.key,
          items: (g.items || [])
            .filter((it) => it.updatedAt)
            .map((it) => ({
              key: it.key,
              label: it.label || it.key,
              updatedAt: it.updatedAt || null,
              sizeBytes: it.sizeBytes || 0,
              articleCount: it.articleCount || 0,
              ready: true,
            })),
        }))
        .filter((g) => g.items.length > 0);
    }
    // 兜底（v1 / 无 manifest）：走 nav 合并
    const groups = await this.groupedList();
    return groups
      .map((g) => ({ ...g, items: g.items.filter((i) => i.ready) }))
      .filter((g) => g.items.length > 0);
  }

  /** 某二级分类是否已生成 PDF */
  async isReady(itemKey: string): Promise<boolean> {
    const map = this.manifestItemMap(await this.readManifest());
    const it = map.get(itemKey);
    return !!it?.updatedAt;
  }

  /** 取某二级分类的展示名（用于下载文件名） */
  private async itemLabel(itemKey: string): Promise<string> {
    for (const g of await this.navGroups()) {
      const c = g.children.find((x) => x.key === itemKey);
      if (c) return c.label;
    }
    const it = this.manifestItemMap(await this.readManifest()).get(itemKey);
    return it?.label || itemKey;
  }

  /** 生成某二级分类 PDF 的 24h 下载签名链接（attachment 另存为分类名） */
  async downloadUrl(itemKey: string): Promise<string> {
    const label = await this.itemLabel(itemKey);
    return this.ossService.signedUrl(
      this.pdfKey(itemKey),
      DOWNLOAD_EXPIRES,
      `${label}.pdf`,
    );
  }

  /**
   * 管理端手动上传/替换某二级分类 PDF（应急兜底，即时覆盖 CI 产物），并更新 manifest（v2）。
   */
  async adminUpload(itemKey: string, buf: Buffer): Promise<MaterialItem> {
    const size = await this.ossService.putPrivate(
      this.pdfKey(itemKey),
      buf,
      'application/pdf',
    );

    // 定位该二级分类归属的一级分组
    const navGroups = await this.navGroups();
    let groupKey = '';
    let groupLabel = '';
    let itemLabel = itemKey;
    for (const g of navGroups) {
      const c = g.children.find((x) => x.key === itemKey);
      if (c) {
        groupKey = g.key;
        groupLabel = g.label;
        itemLabel = c.label;
        break;
      }
    }

    const manifest = await this.readManifest();
    const now = new Date().toISOString();
    // 归一化为 v2 groups
    const groups = Array.isArray(manifest.groups)
      ? manifest.groups.map((g) => ({
          key: g.key,
          label: g.label,
          items: (g.items || []).slice(),
        }))
      : (manifest.categories || []).length
      ? [{ key: 'legacy', label: '历史', items: (manifest.categories || []).slice() }]
      : [];

    const newItem: ManifestItem = {
      key: itemKey,
      label: itemLabel,
      updatedAt: now,
      sizeBytes: size,
      articleCount: 0, // 手动上传不统计文章数
    };

    let group = groups.find((g) => g.key === (groupKey || 'legacy'));
    if (!group) {
      group = { key: groupKey || 'legacy', label: groupLabel || '历史', items: [] };
      groups.push(group);
    }
    group.items = (group.items || []).filter((i) => i.key !== itemKey);
    group.items.push(newItem);

    await this.ossService.putRawText(
      MANIFEST_KEY,
      JSON.stringify({ generatedAt: now, version: 2, groups }, null, 2),
    );

    return {
      key: itemKey,
      label: itemLabel,
      updatedAt: now,
      sizeBytes: size,
      articleCount: 0,
      ready: true,
    };
  }
}
