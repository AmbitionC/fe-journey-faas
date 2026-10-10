# 运营内容管理

新增 `/operations/*` 管理接口，所有入口复用登录 token 与 `assertAdmin`。配图复用现有 OSS 客户端，以 `operations/images/<UUID>.<ext>`、private ACL 保存；预览为 30 分钟签名链接。正文、图片 key、版本与备注仅存现有 `fe-journey` MySQL，不写公开内容仓或公共对象。

## 数据与上线顺序

`operations_content` 是一个稿件一行的文档聚合：列表索引字段 `title/platform/status/updatedAt`，单调递增 `revision`，JSON `document` 包含不可变 `versions`、`publications`、`reviews` 和追加式 `events`。保存采用 `UPDATE ... WHERE id=? AND revision=?`，冲突返回 409，页面保留未保存内容。标题、正文、平台和有序图片一起成为新版本；任何内容修改将当前状态重置为草稿。发布记录固定对应 versionId，后续改稿保留旧发布。审核备注也绑定当时的 versionId。

状态：`draft` 草稿、`in_review` 待审核、`needs_changes` 待修改、`ready` 待发布、`published` 已发布、`archived` 已归档。状态记录是日常操作留存，允许管理员直接调整；`published` 必须走手动发布命令。发布时间必填且不能晚于当前时间，链接可留空但填写时只接收 http/https。每个内容版本最多一条发布记录。

复盘必须关联既有发布记录，观察时间不能早于发布时间或晚于当前时间。`views/likes/saves/comments` 只接受非负安全整数或空值；空值落为 null，显式 0 保留为 0。结论和下次改进均为手录。

上线前由有现有 DB 权限的操作者执行 `scripts/migrations/20261010-operations-content.sql`，核对 `SHOW CREATE TABLE operations_content`。仅新增一个表，不触及已有表、pos/health/invest 库；不自动执行迁移，保持 synchronize=false/dropSchema=false/migrationsRun=false。然后部署后端，再部署依赖它的 manager PR。回退代码时保留新增表和私有资产，无删除迁移。首次生产冒烟应核实匿名/普通用户拒绝、管理员保存、刷新回读和私有图片不可直链访问。

不需要新凭据、服务权限或外部平台连接。没有自动访问、发帖或抓取平台指标的功能。

## 导入格式

`POST /operations/import`，使用现有管理员登录会话。一个主题包含按旧到新排列的版本，各版独立配图。只接收未发布素材，服务生成保存时间/操作者/版本 ID。新建导入生成一个 UUID v4 `idempotencyKey`；结果不确定时用原 JSON 和原 key 重试，防重复创建；同一 key 换素材返回 409。

```json
{
  "idempotencyKey": "ef4d673a-763b-4a79-a1c0-7e31c15210d5",
  "versions": [
    {
      "title": "旧版示例",
      "body": "旧版正文",
      "platform": "xiaohongshu",
      "status": "needs_changes",
      "note": "待修改；仅此版本使用旧配图",
      "images": [
        {
          "key": "operations/images/00000000-0000-4000-8000-000000000000.png",
          "name": "01-cover.png"
        }
      ]
    },
    {
      "title": "新版示例",
      "body": "新版正文",
      "platform": "xiaohongshu",
      "status": "in_review",
      "note": "文案待审核，新版配图尚未制作",
      "images": []
    }
  ]
}
```

示例 UUID 和图片 key 仅说明形状，实际导入使用新 UUID 与真实上传返回的 key。先通过 `/operations/image/upload` 上传实际字节，参数 `{name,dataBase64}`，仅接收 PNG/JPG/WebP、每张不超过 5MB；返回 `{key,name,url}`。导入 `images` 只保留 key/name，顺序就是发布预览顺序，不保存临时签名 url。每版最多 20 图；导入最多 50 版。Library ID 不能当 key 或公开 URL：先按正式 Library 流程下载并核实字节、尺寸与视觉，再上传。禁止绕过素材下载工具的限制。

图片入库前检查容器完整性：PNG 校验 chunk 边界、CRC 和 IEND；JPEG 检查帧/扫描与结束标记；WebP 检查 RIFF 长度、chunk 边界与图像标记。这不替代浏览器解码与视觉核对，解码或网络失败仍显示预览错误并允许重试。

素材到位需提供：每版准确标题/正文/平台/状态/备注、有序图片文件与版本对应关系（新版无图则空数组）。尚未发布时不提供发布时间、链接或指标，不补 0。私有题源、作者与核验报告不可放入公开仓库、测试种子或公开图片。

## 验证

新增模型/服务测试覆盖版本隔离、状态、链接/时间、空指标、并发 CAS、所有 7 个端点权限、上传错误与私有写入大小检查、幂等导入、本地文件适配器持久化回读。文件适配器仅用于单元/浏览器测试，生产唯一存储为 MySQL TypeORM；测试不能替代生产 MySQL/OSS 冒烟。

`test/manual-operations-server.ts` 是独立本地合成数据测试 API，只绑定 127.0.0.1:7003，使用临时文件和合成会话，不加载生产凭据。不会自动部署或生成运营稿素材。
