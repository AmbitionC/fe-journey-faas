/**
 * GitHub ↔ OSS 同步服务
 *
 * 职责：
 * 1. 从 GitHub 读取文章内容 / manifest 文件
 * 2. 将文章内容同步到 OSS
 * 3. 将 manifest 更新写回 GitHub + DB
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

/** GitHub raw 内容基础 URL */
const GH_RAW_BASE =
  process.env.GITHUB_RAW_BASE ||
  'https://raw.githubusercontent.com/Chen-Hao-190408/front-end-journey/main';

/** GitHub API 基础 URL */
const GH_API_BASE =
  process.env.GITHUB_API_BASE ||
  'https://api.github.com/repos/Chen-Hao-190408/front-end-journey';

/** GitHub Personal Access Token */
const GH_TOKEN = process.env.GITHUB_TOKEN || '';

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
 *  GitHub 请求辅助
 * -------------------------------------------------------------------------*/

async function ghRaw(path: string): Promise<string> {
  const url = `${GH_RAW_BASE}/${path}`;
  const res = await fetch(url, {
    headers: GH_TOKEN ? { Authorization: `token ${GH_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`GitHub raw fetch failed: ${url} → ${res.status}`);
  return res.text();
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

  // 2. 写入 GitHub
  const body: Record<string, any> = {
    message:
      commitMessage || `chore: sync ${module}/${key}`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
  };
  if (sha) body.sha = sha;
  await ghApiPut(`contents/${repoPath}`, body);

  // 3. 同步到 OSS
  const oss = new OssService();
  await oss.put(module, filePath, key, content);
}

/**
 * 从 GitHub 删除文章并从 OSS 删除
 */
export async function deleteArticleFromGitHub(
  module: string,
  filePath: string,
  key: string,
  commitMessage?: string
): Promise<void> {
  const repoPath = articlePath(module, filePath, key);

  // 1. 获取当前 SHA
  const fileInfo = await ghApiGet(`contents/${repoPath}`);
  const sha: string = fileInfo.sha;

  // 2. 删除 GitHub 文件
  await ghApiPut(`contents/${repoPath}`, {
    message:
      commitMessage || `chore: delete ${module}/${key}`,
    sha,
    // GitHub API 删除用 DELETE，但通过 PUT with no content 不行，改用 DELETE
  });
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
