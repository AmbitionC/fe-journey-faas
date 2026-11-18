# 项目实战在线试用

网站「项目实战」里每个项目的「在线试用」跑在这里的两个独立函数上：

| 函数 | 作用 | 公网出站 | 密钥 |
|---|---|---|---|
| `project-trial-brain` | 验票据、运行 Agent 内核和模型调用、把过程用 SSE 推给浏览器 | 开（要调模型） | 模型密钥、票据密钥、沙箱令牌 |
| `project-trial-sandbox` | 执行 Agent 要跑的命令（比如 pytest） | 关 | 只有沙箱令牌 |

`brain` 里不执行任何由模型或用户决定的代码，命令全部发到 `sandbox`。`sandbox` 没有外网、没有角色、没有业务密钥。

- 代码源头在 `AmbitionC/agent-journey-projects`，这里的 `general-agent/`、`eval-evolve/`、`ecom-growth/` 是副本，`SOURCE_COMMIT` 记录对应的提交。
  改代码请改源头，再运行 `bash scripts/sync-project-trial.sh <路径>` 同步。
- 部署和冒烟在 `scripts/deploy-project-trial.sh`，由 `deploy.yml` 调用。失败不影响主函数发布，只是试用入口不可用。
- 主函数的 `/project/trial/ticket` 负责登录校验、每日次数和签发票据。
- Python 解释器和 pytest 由部署脚本下载后打进 `pyruntime/`，不进仓库（根目录 .gitignore）。
- 入口服务是 `general-agent/trial/brain_server.py`，启动时会加载旁边各项目的 `trial/plugin.py`（目前有 `eval-evolve`、`ecom-growth`），
  所以几个项目的试用共用这一个入口、一个地址、一套票据。
- `scripts/probe-project-trial.py` 在 CI 里用真模型、对着线上沙箱直接跑某个试用场景并打印全过程，用来在上线前看演示效果
  （`.github/workflows/project-trial-probe.yml`，只在开发分支推送时运行，不部署、不改线上）。
