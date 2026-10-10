# 发布前准备（2026-10-10）

## 现有连接与流程

生产默认数据源固定为 `fe-journey`，从既有 `DB_HOST/DB_USER/DB_PASS` 读取；OSS 从既有 `OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET` 读取。原工作区已有被忽略的 `.env.local`，本次只检查这些配置是否存在，结果均未配置；当前终端环境也未配置。没有读取、复制或打印凭据值。因此本机现在没有可用于该生产迁移/OSS 冒烟的已核实连接，不能直接执行。

当前受支持后端部署路径是 `.github/workflows/deploy.yml` 的 `deploy` job：master push 或 workflow_dispatch，既有 GitHub Secrets 注入凭据，构建后执行 `s fcJourneyMain deploy -y --access aliyun`，并进行基础运行时冒烟。旧 `deploy.sh` 会重新安装依赖、生成入口并移动文件，不作为此次发布方案。部署配置仍保持 `synchronize=false/dropSchema=false/migrationsRun=false`，部署本身不会执行本次 SQL。

最新 master `70a1bb8` 的运维 workflow 还有独立投资定时函数 job。`[journey-only]` 约定只跳过投资定时函数；新增的 `posAlertCron` 部署与健康 dryRun 冒烟仍在 `deploy` job 内无条件运行。因此不能把此标记当作仅发布运营/Web 的完整隔离措施。父线程发布前须协调这项现有 Personal OS 联动，或由已有授权部署操作者仅执行既有 `s fcJourneyMain deploy -y --access aliyun` 命令；仓库当前没有独立 Web-only workflow。本 PR 不修改 Personal OS workflow，不触发部署或改变 Secrets、权限。

仓库尚无自动运行这份 SQL 的迁移工作流。合法执行路径是现有 DB 管理员/已授权数据库客户端，选择 `fe-journey` 后运行 `scripts/migrations/20261010-operations-content.sql`。若应用现有账号没有 CREATE 权限，由已有有权操作者执行；不为本功能创建账号或扩权。当前不能确认该账号的实际 grants，不能把已有生产部署凭据等同于建表授权。生产执行仍需父线程协调既有授权操作者。

## 执行与回退边界

1. 执行前核对目标 `SELECT DATABASE()` 为 `fe-journey`，查看是否已有同名表；若已存在，先核对结构，不能依赖 IF NOT EXISTS 跳过错误结构。
2. SQL 只有一个 `CREATE TABLE IF NOT EXISTS`，含自身索引，没有 ALTER/DROP/DELETE/UPDATE、外键或跨库操作。它是新增且非破坏性的；MySQL DDL 可能隐式提交，不能承诺用事务撤销建表。
3. 核对 `SHOW CREATE TABLE operations_content` 的 JSON 列、主键、索引与 migration 一致。先部署后端，再部署依赖它的 manager。
4. 用既有管理员会话做真实 MySQL 保存/刷新/冲突，以及 OSS 私有 ACL、匿名直链不可读、管理员签名可读的受控冒烟。清楚标记合成稿；不使用真实 Library 图或平台链接，不访问/发布平台。
5. 回退 manager 与后端至本次功能前的兼容代码，并保留 `operations_content` 及全部已写稿件和 OSS 素材。不执行 down migration、不自动删表或删已写内容。旧代码保持 schema 自动同步关闭，因此留表不会引发删表。

不新增管理迁移接口，不向公开接口传入 SQL，不新增凭据或安全权限。CI 的隔离 MySQL 测试仅证明 SQL、TypeORM JSON/CAS 行为，不证明生产 grants 或私有 OSS 已冒烟。
