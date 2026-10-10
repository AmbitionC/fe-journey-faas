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
