/**
 * 内容管理接口
 *
 * 安全说明：
 *  - filePath / key 在使用前均经 assertSafeSegment 校验，防止路径穿越（C1）。
 *  - filePath 经 normalizeFilePath 去除首尾斜杠，保证 GitHub 路径与 OSS objectKey 一致（M1）。
 *  - ArticleQueryDTO.module 已限制枚举（firstclass/interview/knowledge）（C2）。
 *
 * 一致性说明（I1）：
 *  - saveContentArticle / deleteContentArticle 非原子操作，失败可幂等重放：
 *      GitHub putFile 带 sha、upsertLeaf 是 upsert、DB save 是覆盖式、OSS 操作幂等。
 *  - OSS 步骤（内容缓存）在 syncArticleToOss / deleteArticleFromGitHub 内部已用 try/catch
 *    包住，失败仅记日志不阻断主流程（详见 sync.ts）。
 *  - GitHub 写入（真相源）失败时抛错让调用方重试。
 *
 * 并发保护（I2）：
 *  - _tree.json 的「读 → 改 → putFile」放在 updateManifestWithRetry 乐观重试循环中，
 *    捕获 GitHub 409 后重新读取并重算，最多重试 3 次（详见 sync.ts）。
 *
 * 原子 version（I3）：
 *  - DB 中 version 自增通过 navConfigModel.increment 原子完成，避免并发下版本回退。
 *
 * deleteArticle 完整一致性：
 *  - 删除时先删 GitHub .md 文件（真相源），再更新 _tree.json manifest，最后更新 DB。
 *    OSS 删除在 deleteArticleFromGitHub 内部处理（失败不阻断）。
 */
import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Body,
  Query,
  ALL,
  Config,
  Inject,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { NavConfigEntity } from '../entity/navConfig';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';
import {
  TreeQueryDTO,
  ArticleQueryDTO,
  SaveArticleDTO,
  DeleteArticleDTO,
  TreeUpdateDTO,
  UploadImageDTO,
  SyncDTO,
} from '../dto/content';
import {
  articlePath,
  isFlat,
  manifestPath,
} from '../service/content/modules';
import {
  fetchArticleFromGitHub,
  syncArticleToOss,
  deleteArticleFromGitHub,
  upsertLeaf,
  removeLeaf,
  updateManifestWithRetry,
  listChangedSince,
  syncChanged,
} from '../service/content/sync';
import { OssService } from '../service/content/oss';
import { assertSafeSegment, normalizeFilePath } from '../service/content/path';

@Provide()
export class ContentHTTPService {
  @Inject() ctx: Context;

  @Config('syncSecret') syncSecret: string;

  @InjectEntityModel(NavConfigEntity)
  navConfigModel: Repository<NavConfigEntity>;

  // -----------------------------------------------------------------------
  // 查询导航树
  // -----------------------------------------------------------------------
  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取内容模块导航树',
    functionName: 'getContentTree',
    name: 'getContentTree',
    path: '/content/tree',
    method: 'get',
  })
  async getContentTree(@Query(ALL) query: TreeQueryDTO): Promise<any> {
    const config = await this.navConfigModel.findOneBy({
      module: query.module,
    });
    if (!config) throw R.error(`模块 ${query.module} 的导航配置不存在`);
    return { success: true, data: { navData: config.navData, version: config.version } };
  }

  // -----------------------------------------------------------------------
  // 读取文章内容（从 GitHub raw 读取）
  // -----------------------------------------------------------------------
  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取文章内容',
    functionName: 'getContentArticle',
    name: 'getContentArticle',
    path: '/content/article',
    method: 'get',
  })
  async getContentArticle(@Query(ALL) query: ArticleQueryDTO): Promise<any> {
    // C1: 路径穿越防护
    const filePath = normalizeFilePath(query.filePath || '');
    assertSafeSegment(filePath, query.key);

    // 扁平模块不需要 filePath，普通模块需要
    if (!isFlat(query.module) && !filePath) {
      throw R.error('普通模块的 filePath 不能为空');
    }

    const content = await fetchArticleFromGitHub(
      query.module,
      filePath,
      query.key
    );
    return { success: true, data: { content } };
  }

  // -----------------------------------------------------------------------
  // 保存文章（写入 GitHub + OSS + 更新 manifest in GitHub + DB）
  // -----------------------------------------------------------------------
  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '保存文章内容',
    functionName: 'saveContentArticle',
    name: 'saveContentArticle',
    path: '/content/article/save',
    method: 'post',
  })
  async saveContentArticle(@Body(ALL) body: SaveArticleDTO): Promise<any> {
    // C1: 路径穿越防护
    const filePath = normalizeFilePath(body.filePath || '');
    assertSafeSegment(filePath, body.key);

    if (!isFlat(body.module) && !filePath) {
      throw R.error('普通模块的 filePath 不能为空');
    }

    // 1. 将文章内容写入 GitHub + OSS（OSS 失败不阻断，见 sync.ts I1）
    await syncArticleToOss(
      body.module,
      filePath,
      body.key,
      body.content || '',
      `chore: save ${body.module}/${body.key}`
    );

    // 2. 更新 GitHub manifest（_tree.json），乐观重试（I2）
    const leaf: Record<string, any> = {
      label: body.label,
      key: body.key,
      isLeaf: true,
    };
    if (!isFlat(body.module)) {
      leaf.filePath = filePath;
    }
    if (body.tags !== undefined) leaf.tags = body.tags;
    if (body.currRank !== undefined) leaf.currRank = body.currRank;

    await updateManifestWithRetry(
      body.module,
      (tree) => upsertLeaf(tree, body.parentKey, leaf),
      `chore: update manifest for ${body.module}/${body.key}`
    );

    // 3. 更新 DB 中的 navData（I3：version 原子自增）
    const existing = await this.navConfigModel.findOneBy({ module: body.module });
    if (!existing) {
      // 首次创建：直接 insert，version 为 1
      const config = this.navConfigModel.create({
        module: body.module,
        navData: upsertLeaf([], body.parentKey, leaf),
        version: 1,
      });
      await this.navConfigModel.save(config);
    } else {
      const updatedNavData = upsertLeaf(existing.navData || [], body.parentKey, leaf);
      await this.navConfigModel.update({ module: body.module }, { navData: updatedNavData });
      await this.navConfigModel.increment({ module: body.module }, 'version', 1);
    }

    return {
      success: true,
      data: {
        objectKey: articlePath(body.module, filePath, body.key),
        manifestPath: manifestPath(body.module),
      },
    };
  }

  // -----------------------------------------------------------------------
  // 删除文章（从 GitHub 删除 + OSS 删除 + 更新 manifest in GitHub + DB）
  // -----------------------------------------------------------------------
  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除文章',
    functionName: 'deleteContentArticle',
    name: 'deleteContentArticle',
    path: '/content/article/delete',
    method: 'post',
  })
  async deleteContentArticle(@Body(ALL) body: DeleteArticleDTO): Promise<any> {
    // C1: 路径穿越防护
    const filePath = normalizeFilePath(body.filePath || '');
    assertSafeSegment(filePath, body.key);

    if (!isFlat(body.module) && !filePath) {
      throw R.error('普通模块的 filePath 不能为空');
    }

    // 1. 删除 GitHub .md 文件（真相源）+ OSS 缓存（OSS 失败不阻断，见 sync.ts I1）
    await deleteArticleFromGitHub(
      body.module,
      filePath,
      body.key,
      `chore: delete ${body.module}/${body.key}`
    );

    // 2. 更新 GitHub manifest（_tree.json），乐观重试（I2）
    await updateManifestWithRetry(
      body.module,
      (tree) => removeLeaf(tree, body.key),
      `chore: update manifest remove ${body.module}/${body.key}`
    );

    // 3. 更新 DB 中的 navData（I3：version 原子自增）
    const config = await this.navConfigModel.findOneBy({ module: body.module });
    if (config) {
      const updatedNavData = removeLeaf(config.navData || [], body.key);
      await this.navConfigModel.update({ module: body.module }, { navData: updatedNavData });
      await this.navConfigModel.increment({ module: body.module }, 'version', 1);
    }

    return { success: true };
  }

  // -----------------------------------------------------------------------
  // 更新导航树（覆盖写入 DB）
  // -----------------------------------------------------------------------
  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '更新内容导航树',
    functionName: 'updateContentTree',
    name: 'updateContentTree',
    path: '/content/tree/update',
    method: 'post',
  })
  async updateContentTree(@Body(ALL) body: TreeUpdateDTO): Promise<any> {
    let config = await this.navConfigModel.findOneBy({ module: body.module });
    if (!config) {
      config = this.navConfigModel.create({
        module: body.module,
        navData: body.navData,
        version: 1,
      });
    } else {
      config.navData = body.navData;
      config.version = (config.version || 1) + 1;
    }
    await this.navConfigModel.save(config);
    return { success: true, data: { version: config.version } };
  }

  // -----------------------------------------------------------------------
  // 上传图片到 OSS
  // -----------------------------------------------------------------------
  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '上传图片到 OSS',
    functionName: 'uploadContentImage',
    name: 'uploadContentImage',
    path: '/content/image/upload',
    method: 'post',
  })
  async uploadContentImage(@Body(ALL) body: UploadImageDTO): Promise<any> {
    // C1: fileName 安全校验（不允许路径分隔符和 ..）
    assertSafeSegment('', body.fileName);
    const buf = Buffer.from(body.dataBase64, 'base64');
    const oss = new OssService();
    const objKey = await oss.putImage(body.fileName, buf);
    return { success: true, data: { objectKey: objKey } };
  }

  // -----------------------------------------------------------------------
  // 增量同步（CI GitHub Action 用）
  // -----------------------------------------------------------------------
  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '从 git push 增量同步内容到 OSS（CI 用）',
    functionName: 'syncContent',
    name: 'syncContent',
    path: '/content/sync',
    method: 'post',
  })
  async syncContent(@Body(ALL) body: SyncDTO): Promise<any> {
    // 校验 x-sync-secret header，不匹配则抛 401
    const secret = this.ctx.headers['x-sync-secret'];
    if (!this.syncSecret || secret !== this.syncSecret) {
      throw R.unauthorizedError('sync 需要有效的 x-sync-secret');
    }

    // 获取变更文件列表：优先使用请求体中的 files，否则调 GitHub compare API
    let files = body.files;
    if (!files && body.beforeSha && body.afterSha) {
      files = await listChangedSince(body.beforeSha, body.afterSha);
    }
    if (!files) files = [];

    const oss = new OssService();

    // 构建 saveNavToDb 回调（写入 DB 并原子自增 version）
    const saveNavToDb = async (module: string, navData: any): Promise<void> => {
      const existing = await this.navConfigModel.findOneBy({ module });
      if (!existing) {
        const config = this.navConfigModel.create({ module, navData, version: 1 });
        await this.navConfigModel.save(config);
      } else {
        await this.navConfigModel.update({ module }, { navData });
        await this.navConfigModel.increment({ module }, 'version', 1);
      }
    };

    const result = await syncChanged(files, saveNavToDb, oss);
    return { success: true, data: result };
  }
}
