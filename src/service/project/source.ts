import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 项目实战「源码下载」（会员权益）。
 *
 * zip 由 scripts/sync-project-trial.sh 从 agent-journey-projects 仓库打出来、随本仓库提交
 * （project-source/<项目>.zip），和在线试用跑的是同一个提交的代码。下载时按内容哈希定对象名，OSS 上没有就以私有对象传一次，
 * 然后签发临时链接——公网直链不可达，和会员 PDF 是同一套做法。
 */

export interface SourceProject {
  /** 下载时另存为的文件名 */
  filename: string;
}

/** 已开放源码下载的项目。新增项目时在这里登记，并在 sync-project-trial.sh 里加上打包。 */
export const SOURCE_PROJECTS: Record<string, SourceProject> = {
  'general-agent': { filename: 'agent-journey-general-agent.zip' },
  'eval-evolve': { filename: 'agent-journey-eval-evolve.zip' },
  'ecom-growth': { filename: 'agent-journey-ecom-growth.zip' },
};

export const SOURCE_URL_EXPIRES_SEC = 3600;

export function sourceZipPath(projectId: string, root: string = process.cwd()): string {
  return path.join(root, 'project-source', `${projectId}.zip`);
}

export interface SourcePackage {
  buf: Buffer;
  objKey: string;
}

const cache = new Map<string, SourcePackage>();

/** 读出代码包里的 zip；没有就返回 null。 */
export function loadSourcePackage(projectId: string, root?: string): SourcePackage | null {
  const file = sourceZipPath(projectId, root);
  const hit = cache.get(file);
  if (hit) return hit;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (!buf.length) return null;
  const digest = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const pkg = { buf, objKey: `project-source/${projectId}/${digest}.zip` };
  cache.set(file, pkg);
  return pkg;
}
