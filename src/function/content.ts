import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Body,
  Query,
  ALL,
} from '@midwayjs/core';
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
} from '../dto/content';
import {
  articlePath,
  isFlat,
  manifestPath,
} from '../service/content/modules';
import {
  fetchArticleFromGitHub,
  syncArticleToOss,
  upsertLeaf,
  removeLeaf,
} from '../service/content/sync';
import { OssService } from '../service/content/oss';

/** 合法 segment 字符（路径中不允许的字符） */
const SAFE_RE = /^[a-zA-Z0-9_\-/.]+$/;

function assertSafeSegment(value: string | undefined, name: string): void {
  if (value === undefined || value === '') return; // 空字符串对扁平模块合法
  if (!SAFE_RE.test(value)) {
    throw R.error(`不合法的 ${name}: ${value}`);
  }
}

@Provide()
export class ContentHTTPService {
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
    const filePath = query.filePath || '';
    assertSafeSegment(filePath, 'filePath');
    assertSafeSegment(query.key, 'key');

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
  // 保存文章（写入 GitHub + OSS + 更新 manifest in DB）
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
    const filePath = body.filePath || '';
    assertSafeSegment(filePath, 'filePath');
    assertSafeSegment(body.key, 'key');

    if (!isFlat(body.module) && !filePath) {
      throw R.error('普通模块的 filePath 不能为空');
    }

    // 1. 将文章内容同步到 GitHub + OSS
    await syncArticleToOss(
      body.module,
      filePath,
      body.key,
      body.content || '',
      `chore: save ${body.module}/${body.key}`
    );

    // 2. 更新 DB 中的 navData（upsert leaf）
    let config = await this.navConfigModel.findOneBy({ module: body.module });
    if (!config) {
      config = this.navConfigModel.create({
        module: body.module,
        navData: [],
        version: 1,
      });
    }

    // 构建叶子对象（扁平模块不写 filePath 字段）
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

    config.navData = upsertLeaf(config.navData || [], body.parentKey, leaf);
    config.version = (config.version || 1) + 1;
    await this.navConfigModel.save(config);

    return {
      success: true,
      data: {
        objectKey: articlePath(body.module, filePath, body.key),
        manifestPath: manifestPath(body.module),
      },
    };
  }

  // -----------------------------------------------------------------------
  // 删除文章（从 GitHub 删除 + OSS 删除 + 更新 manifest in DB）
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
    const filePath = body.filePath || '';
    assertSafeSegment(filePath, 'filePath');
    assertSafeSegment(body.key, 'key');

    if (!isFlat(body.module) && !filePath) {
      throw R.error('普通模块的 filePath 不能为空');
    }

    // 1. 从 OSS 删除
    try {
      const oss = new OssService();
      await oss.delete(body.module, filePath, body.key);
    } catch {
      // 忽略 OSS 删除失败（文件可能不存在）
    }

    // 2. 更新 DB navData（remove leaf）
    const config = await this.navConfigModel.findOneBy({ module: body.module });
    if (config) {
      config.navData = removeLeaf(config.navData || [], body.key);
      config.version = (config.version || 1) + 1;
      await this.navConfigModel.save(config);
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
    assertSafeSegment(body.fileName, 'fileName');
    const buf = Buffer.from(body.dataBase64, 'base64');
    const oss = new OssService();
    const objKey = await oss.putImage(body.fileName, buf);
    return { success: true, data: { objectKey: objKey } };
  }
}
