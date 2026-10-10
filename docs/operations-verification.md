# 本地验证记录（2026-10-10）

基线为 master `1e9bbff`，Node 22.22.3，未加载生产凭据，未执行数据库迁移或部署。

- 运营专项模型与服务测试：16/16 通过。覆盖不可变版本、有序图片、状态记录、发布时间/链接、复盘空值与整数校验、旧发布复盘引用、缺失 ID、并发 CAS、全部 7 个端点匿名/普通用户拒绝、管理员 token 回查、上传失败、私有上传字节确认、导入幂等和文件存储重建后回读。
- `tsc --noEmit`、`npm run build` 通过；新增生产源文件 ESLint 无错误（仓库规则忽略 test 目录）。
- 绕过现有全局应用启动的完整单元套件：332 passing / 2 pending / 2 failing。失败为 `test/workflow/redact.test.ts:94` 和 `test/workflow/summarize.test.ts:29`，本机 awk 报 newline in string。从同一 origin/master 导出的干净基线单独复跑这两组测试得到相同 2 项失败，10 项通过。
- 标准 `npm test` 在全局 Midway 应用启动时被已有评测 CLI 的“缺少 LLM_API_KEY”中止；本次未引入凭据或修改该启动流程。

专项命令（Node 22）：

```sh
node --no-experimental-strip-types node_modules/mocha/bin/mocha.js --no-config --require ts-node/register test/operations.test.ts test/operations.service.test.ts
node_modules/.bin/tsc --noEmit
npm run build
```

上述文件存储适配器和本地 HTTP 测试服务仅用于验证。真实 MySQL JSON/CAS、OSS ACL 与签名链接、正式登录会话仍需在部署前后的受控环境冒烟。未将本地通过当作生产验证。

## 连接恢复后的补验收

初始 PR head `f97cc41a39419a292b14c073831360d8694ec490` 的实际 GitHub Actions run `38032337861`：标准 `npm test` 334 passing / 2 pending，类型检查通过，无 continue-on-error；GitHub 上暂无提交的 PR review。父线程对该 head 的只读独审条件通过。

本地真实 HTTP 测试使用明显标注的合成文件与临时目录：完整 5MB PNG 返回 200，5MB+1 返回 400。40B 截断 PNG 原先错误返回 200，新增完整性校验后返回 400；PNG/JPG/WebP 合成字节均返回 200。仅校验容器，不承诺替代完整解码/视觉检查。

复用 owned 测试目录重启 API 进程后，实际回读 4 个内容版本、原发布版本 ID、最新草稿、02/01 图片顺序、阅读 null 与点赞 0；不是生产 MySQL 的证据。补充独立代码审核后继续校验 progressive JPEG 后续扫描段和动画 WebP 帧内 chunk；真实合成 progressive JPEG/动画 bitstream 接受，后续 DHT 段越界、缺帧 bitstream、帧内 chunk 越界在 OSS 写入前拒绝。修复后的本地专项为 19 passing / 3 pending（3 项真实 MySQL 测试在本机刻意跳过），类型检查、新增生产文件 ESLint 通过。

新增 `test/operations.mysql.test.ts` 只在现有 CI 隔离 MySQL 服务条件全部匹配时运行：CI=true、NODE_ENV=unittest、DB_HOST=127.0.0.1、DB_USER=root、既有 testpass。执行原 SQL 并验证 JSON 列/索引、新连接回读发布快照和 null/0、真实条件 UPDATE 并发仅一成功。不会连接生产库；清理也仅删除该隔离容器内本测试创建的 UUID 记录，不删表。最终 CI 结果需对最终 head 核对。
