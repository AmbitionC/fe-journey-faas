/**
 * GitHub ↔ OSS 同步服务
 *
 * 职责：
 * 1. 从 GitHub 读取文章内容 / manifest 文件
 * 2. 将文章内容同步到 OSS
 * 3. 将 manifest 更新写回 GitHub + DB
 *
 * 一致性说明（I1）：
 *  - syncArticleToOss / deleteArticleFromGitHub 非原子操作，失败可幂等重放：
 *      putFile 带 sha、OSS put 幂等、OSS delete 幂等。
 *  - OSS 步骤（内容缓存）用 try/catch 包住，失败仅记日志不阻断主流程。
 *  - GitHub 写入（真相源）失败时抛错让调用方重试。
 *
 * 并发保护（I2）：
 *  - _tree.json 的「读 → 改 → putFile」放在乐观重试循环中，捕获 GitHub 409 后重新读取并重算，
 *    最多重试 3 次，保证并发操作不会丢更新。
 */
import fetch from 'node-fetch';
import { OssService } from './oss';
import {
  ALL_MODULES,
  articlePath,
  isFlat,
  manifestPath,
  moduleOfPath,
  repoDir,
} from './modules';

/** GitHub API 基础 URL */
const GH_API_BASE =
  process.env.GITHUB_API_BASE ||
  'https://api.github.com/repos/Chen-Hao-190408/front-end-journey';

/** GitHub Personal Access Token */
const GH_TOKEN = process.env.GITHUB_TOKEN || '';

/** 最大乐观重试次数（I2） */
const TREE_MAX_RETRIES = 3;

/** -------------------------------------------------------------------------
 *  工具函数（纯函数，便于单元测试）
 * -------------------------------------------------------------------------*/

/**
 * 判断给定仓库路径是否为 manifest 文件（任意模块的 _tree.json）
 */
export function isTreeManifest(repoPath: string): boolean {
  return ALL_MODULES.some(m => repoPath === manifestPath(m));
}

export interface ParsedArticlePath {
  module: string;
  filePath: string;
  key: string;
}

/**
 * 解析仓库路径，返回 {module, filePath, key}；
 * 不认识的路径（manifest、images 等）返回 null。
 *
 * - 扁平模块(firstclass): `class/{key}.md`  → filePath = ''
 * - 普通模块: `{module}/{filePath}/{key}.md`
 */
export function parseArticlePath(
  repoPath: string
): ParsedArticlePath | null {
  // 排除非 .md 文件
  if (!repoPath.endsWith('.md')) return null;

  // 排除 manifest 文件（_tree.json 已由 isTreeManifest 判断，此处防止万一
  // manifest 被命名为 .md 扩展名——当前不会，但防御一下）
  if (repoPath.includes('_tree')) return null;

  // 排除图片目录
  if (repoPath.startsWith('images/')) return null;

  // 确定所属模块
  const module = moduleOfPath(repoPath);
  if (!module) return null;

  const dir = repoDir(module);
  // 去掉前缀 "dir/"
  const rest = repoPath.slice(dir.length + 1); // e.g. "key.md" 或 "filePath/key.md"

  if (isFlat(module)) {
    // 扁平模块：rest = "{key}.md"
    const key = rest.replace(/\.md$/, '');
    if (!key || key.includes('/')) return null;
    return { module, filePath: '', key };
  } else {
    // 普通模块：rest = "{filePath}/{key}.md"
    const lastSlash = rest.lastIndexOf('/');
    if (lastSlash < 0) return null; // 没有 filePath，不合法
    const filePath = rest.slice(0, lastSlash);
    const key = rest.slice(lastSlash + 1).replace(/\.md$/, '');
    if (!filePath || !key) return null;
    return { module, filePath, key };
  }
}

/** -------------------------------------------------------------------------
 *  公共类型：变更文件条目（listChangedSince / syncChanged 共用）
 * -------------------------------------------------------------------------*/

export interface ChangedFile {
  /** 仓库相对路径，例如 "interview/tencent/base/x.md" */
  path: string;
  /** GitHub compare API 返回的 status 字段：added / modified / removed 等 */
  status: string;
}

/** -------------------------------------------------------------------------
 *  GitHub 请求辅助
 * -------------------------------------------------------------------------*/

// 取文件文本内容。改走 api.github.com Contents API(base64 解码),
// 不用 raw.githubusercontent.com —— 后者从阿里云 FC(国内)经常连不通。
async function ghRaw(path: string): Promise<string> {
  const json = await ghApiGet(`contents/${path}`);
  return Buffer.from(String(json.content).replace(/\n/g, ''), 'base64').toString(
    'utf8'
  );
}

async function ghApiGet(path: string): Promise<any> {
  const url = `${GH_API_BASE}/${path}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(GH_TOKEN ? { Authorization: `token ${GH_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API GET failed: ${url} → ${res.status}`);
  return res.json();
}

async function ghApiPut(
  path: string,
  body: Record<string, any>
): Promise<any> {
  const url = `${GH_API_BASE}/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(GH_TOKEN ? { Authorization: `token ${GH_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub API PUT failed: ${url} → ${res.status}: ${txt}`);
  }
  return res.json();
}

async function ghApiDelete(
  path: string,
  body: Record<string, any>
): Promise<any> {
  const url = `${GH_API_BASE}/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(GH_TOKEN ? { Authorization: `token ${GH_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub API DELETE failed: ${url} → ${res.status}: ${txt}`);
  }
  // GitHub DELETE /contents returns 200 with JSON or empty body
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** -------------------------------------------------------------------------
 *  增量同步：compare API
 * -------------------------------------------------------------------------*/

/**
 * 使用 GitHub compare API 列出 beforeSha..afterSha 之间变更的文件列表。
 *
 * 对应 GET /repos/{owner}/{repo}/compare/{basehead}
 *
 * @param beforeSha  起始 commit SHA
 * @param afterSha   结束 commit SHA
 * @returns 变更文件列表，每项含 path 与 status
 */
export async function listChangedSince(
  beforeSha: string,
  afterSha: string
): Promise<ChangedFile[]> {
  const json = await ghApiGet(`compare/${beforeSha}...${afterSha}`);
  const files: any[] = json.files || [];
  return files.map((f: any) => ({ path: String(f.filename), status: String(f.status) }));
}

/**
 * 从 GitHub 读取文件的原始 Buffer（用于图片等二进制文件）。
 * 返回 null 表示文件不存在（404）。
 */
export async function getRawBuffer(path: string): Promise<Buffer | null> {
  const url = `${GH_API_BASE}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(GH_TOKEN ? { Authorization: `token ${GH_TOKEN}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub getRawBuffer ${path} 失败: ${res.status}`);
  const json: any = await res.json();
  return Buffer.from(String(json.content).replace(/\n/g, ''), 'base64');
}

export interface SyncChangedResult {
  manifests: number;
  articles: number;
  images: number;
  deleted: number;
  errors: string[];
}

/** 可注入的 I/O 依赖（便于单元测试时 mock） */
export interface SyncChangedIO {
  /** 从仓库读取文本内容（raw URL）*/
  fetchText: (repoPath: string) => Promise<string>;
  /** 从仓库读取二进制内容（用于图片）；返回 null 表示文件不存在 */
  fetchBuffer: (repoPath: string) => Promise<Buffer | null>;
}

/** 默认 IO：直接调用内部 GitHub 辅助函数 */
const defaultSyncIO: SyncChangedIO = {
  fetchText: ghRaw,
  fetchBuffer: getRawBuffer,
};

/**
 * 处理一批变更文件，将其同步到 OSS / 更新 DB。
 *
 * - manifest (_tree.json) → refreshNav 对应模块
 * - article (.md) → 改/增则同步 OSS；status=removed 则删 OSS
 * - images/ → 同步图片（二进制安全）
 *
 * 单条失败不阻断整批，失败信息收集到 errors。
 *
 * @param io  可注入的 I/O 依赖（默认使用 GitHub raw/API，测试时可 mock）
 */
export async function syncChanged(
  files: ChangedFile[],
  saveNavToDb: (module: string, navData: any) => Promise<void>,
  oss: { put: (m: string, fp: string, k: string, c: string) => Promise<void>; delete: (m: string, fp: string, k: string) => Promise<void>; putImage: (name: string, buf: Buffer) => Promise<string> },
  io: SyncChangedIO = defaultSyncIO,
): Promise<SyncChangedResult> {
  const result: SyncChangedResult = { manifests: 0, articles: 0, images: 0, deleted: 0, errors: [] };

  for (const file of files) {
    try {
      // ---- manifest ----
      if (isTreeManifest(file.path)) {
        const module = ALL_MODULES.find(m => file.path === manifestPath(m));
        if (module) {
          const text = await io.fetchText(file.path);
          const navData = JSON.parse(text);
          await saveNavToDb(module, navData);
          result.manifests++;
        }
        continue;
      }

      // ---- image ----
      if (file.path.startsWith('images/')) {
        if (file.status === 'removed') {
          // OSS 图片删除（尽力而为，key 与 repoPath 一致）
          try {
            const ossClient = oss as any;
            if (typeof ossClient.deleteRaw === 'function') {
              await ossClient.deleteRaw(file.path);
            }
          } catch { /* 忽略，图片删除失败不阻断 */ }
          result.deleted++;
        } else {
          const buf = await io.fetchBuffer(file.path);
          if (buf) {
            const fileName = file.path.replace(/^images\//, '');
            await oss.putImage(fileName, buf);
            result.images++;
          }
        }
        continue;
      }

      // ---- article ----
      const parsed = parseArticlePath(file.path);
      if (!parsed) continue;

      if (file.status === 'removed') {
        try {
          await oss.delete(parsed.module, parsed.filePath, parsed.key);
        } catch { /* 忽略，OSS 删除失败不阻断 */ }
        result.deleted++;
      } else {
        // added / modified / renamed / copied
        const content = await io.fetchText(file.path);
        await oss.put(parsed.module, parsed.filePath, parsed.key, content);
        result.articles++;
      }
    } catch (e: any) {
      result.errors.push(`${file.path}: ${e?.message || String(e)}`);
    }
  }

  return result;
}

/** -------------------------------------------------------------------------
 *  同步操作
 * -------------------------------------------------------------------------*/

/** 从 GitHub 读取文章 Markdown 内容 */
export async function fetchArticleFromGitHub(
  module: string,
  filePath: string,
  key: string
): Promise<string> {
  const path = articlePath(module, filePath, key);
  return ghRaw(path);
}

/**
 * 将文章写入 GitHub 并同步到 OSS
 *
 * 非原子操作，失败可幂等重放（putFile 带 sha、OSS put 幂等）。
 * OSS 步骤失败仅记日志不阻断（I1）。
 *
 * @param module  模块名
 * @param filePath 子路径（扁平模块传 ''）
 * @param key     文章 key
 * @param content Markdown 内容
 * @param commitMessage Git commit 消息
 */
export async function syncArticleToOss(
  module: string,
  filePath: string,
  key: string,
  content: string,
  commitMessage?: string
): Promise<void> {
  const repoPath = articlePath(module, filePath, key);

  // 1. 获取当前文件的 SHA（创建/更新 GitHub 文件时需要）
  let sha: string | undefined;
  try {
    const fileInfo = await ghApiGet(`contents/${repoPath}`);
    sha = fileInfo.sha;
  } catch {
    // 文件不存在，创建新文件
  }

  // 2. 写入 GitHub（真相源，失败直接抛错）
  const body: Record<string, any> = {
    message:
      commitMessage || `chore: sync ${module}/${key}`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
  };
  if (sha) body.sha = sha;
  await ghApiPut(`contents/${repoPath}`, body);

  // 3. 同步到 OSS（内容缓存，失败不阻断）（I1）
  try {
    const oss = new OssService();
    await oss.put(module, filePath, key, content);
  } catch (ossErr) {
    console.error('[syncArticleToOss] OSS 同步失败（可由 sync 补偿）:', ossErr);
  }
}

/**
 * 从 GitHub 删除文章并从 OSS 删除
 *
 * 非原子操作，失败可幂等重放（GitHub delete 带 sha，OSS delete 幂等）。
 * OSS 步骤失败仅记日志不阻断（I1）。
 *
 * @param module  模块名
 * @param filePath 子路径（扁平模块传 ''）
 * @param key     文章 key
 * @param commitMessage Git commit 消息
 */
export async function deleteArticleFromGitHub(
  module: string,
  filePath: string,
  key: string,
  commitMessage?: string
): Promise<void> {
  const repoPath = articlePath(module, filePath, key);

  // 1. 获取当前 SHA（删除 GitHub 文件需要 sha）
  const fileInfo = await ghApiGet(`contents/${repoPath}`);
  const sha: string = fileInfo.sha;

  // 2. 删除 GitHub 文件（真相源，失败直接抛错）
  await ghApiDelete(`contents/${repoPath}`, {
    message: commitMessage || `chore: delete ${module}/${key}`,
    sha,
  });

  // 3. 删除 OSS 缓存（失败不阻断）（I1）
  try {
    const oss = new OssService();
    await oss.delete(module, filePath, key);
  } catch (ossErr) {
    console.error('[deleteArticleFromGitHub] OSS 删除失败（可由 sync 补偿）:', ossErr);
  }
}

/** -------------------------------------------------------------------------
 *  Manifest（_tree.json）操作
 * -------------------------------------------------------------------------*/

/** 读取模块的 manifest JSON */
export async function readManifest(module: string): Promise<any> {
  const path = manifestPath(module);
  const text = await ghRaw(path);
  return JSON.parse(text);
}

/**
 * 在 manifest 中插入/更新一个叶子节点，并将更新后的 manifest 写回 GitHub
 *
 * @param module     模块名
 * @param navData    当前 navData 数组（调用者从 DB 读取）
 * @param parentKey  父节点 key（空时追加到顶层）
 * @param leaf       叶子节点数据
 */
export function upsertLeaf(
  navData: any[],
  parentKey: string,
  leaf: Record<string, any>
): any[] {
  if (!parentKey) {
    // 追加到顶层
    const idx = navData.findIndex(n => n.key === leaf.key);
    if (idx >= 0) {
      navData[idx] = { ...navData[idx], ...leaf };
    } else {
      navData.push(leaf);
    }
    return navData;
  }

  // 递归查找父节点
  function traverse(nodes: any[]): boolean {
    for (const node of nodes) {
      if (node.key === parentKey) {
        if (!node.children) node.children = [];
        const idx = node.children.findIndex((c: any) => c.key === leaf.key);
        if (idx >= 0) {
          node.children[idx] = { ...node.children[idx], ...leaf };
        } else {
          node.children.push(leaf);
        }
        return true;
      }
      if (node.children && traverse(node.children)) return true;
    }
    return false;
  }

  traverse(navData);
  return navData;
}

/**
 * 从 navData 中删除指定 key 的叶子节点
 */
export function removeLeaf(navData: any[], key: string): any[] {
  function traverse(nodes: any[]): any[] {
    return nodes
      .filter(n => n.key !== key)
      .map(n => {
        if (n.children) {
          return { ...n, children: traverse(n.children) };
        }
        return n;
      });
  }
  return traverse(navData);
}

/**
 * 刷新模块导航（从 GitHub 读取 manifest 并写入 DB）
 * 此函数依赖外部传入的 DB 写入回调，避免在纯函数中引入 Midway DI。
 */
export async function refreshNav(
  module: string,
  saveToDb: (navData: any) => Promise<void>
): Promise<void> {
  const navData = await readManifest(module);
  await saveToDb(navData);
}

/** -------------------------------------------------------------------------
 *  GitHub manifest（_tree.json）乐观重试写入（I2）
 * -------------------------------------------------------------------------*/

/**
 * 读取 manifest → 执行变更 → 写回 GitHub，遇到 409（sha 过期）重试最多 TREE_MAX_RETRIES 次。
 *
 * @param module      模块名
 * @param transform   对当前 manifest JSON 数组做变更的函数
 * @param commitMsg   commit 消息
 */
export async function updateManifestWithRetry(
  module: string,
  transform: (tree: any[]) => any[],
  commitMsg: string
): Promise<void> {
  const treePath = manifestPath(module);

  for (let attempt = 0; attempt < TREE_MAX_RETRIES; attempt++) {
    // 1. 读取当前 manifest（及 sha）
    let currentSha: string | undefined;
    let tree: any[] = [];
    try {
      const fileInfo = await ghApiGet(`contents/${treePath}`);
      currentSha = fileInfo.sha;
      const content = Buffer.from(fileInfo.content, 'base64').toString('utf-8');
      tree = JSON.parse(content);
    } catch {
      // 文件不存在，从空数组开始
    }

    // 2. 执行变更
    const updatedTree = transform(tree);

    // 3. 写回 GitHub
    const body: Record<string, any> = {
      message: commitMsg,
      content: Buffer.from(
        JSON.stringify(updatedTree, null, 2) + '\n',
        'utf-8'
      ).toString('base64'),
    };
    if (currentSha) body.sha = currentSha;

    try {
      await ghApiPut(`contents/${treePath}`, body);
      return; // 成功，退出
    } catch (e: any) {
      const is409 =
        e?.message?.includes('409') || e?.message?.includes('422');
      if (!is409 || attempt === TREE_MAX_RETRIES - 1) throw e;
      // 409 sha 过期：重读最新 sha 并重算，继续下一次循环
    }
  }
}
