#!/usr/bin/env bash
# 部署 Iris 代码运行函数 iris-code-runner，并做隔离冒烟。成功后把地址和令牌写进 $GITHUB_ENV，
# 供随后部署主函数时注入（CODE_RUNNER_URL / CODE_RUNNER_TOKEN）。任何一步失败都非零退出，
# 调用方据此不注入 → 主函数里 run_code 工具自动不提供，不影响主函数部署。
# 前置：已 `s config add --access aliyun`；环境变量 SYNC_SECRET、AK_ID、AK_SECRET、ACCOUNT_ID。
set -euo pipefail

if [ -z "${SYNC_SECRET:-}" ]; then echo "SYNC_SECRET 为空，无法派生运行函数令牌"; exit 1; fi
# 令牌由已有 secret 派生（单向哈希），不新增 secret，也不会反推出 SYNC_SECRET
CODE_RUNNER_TOKEN=$(printf 'iris-code-runner:%s' "$SYNC_SECRET" | sha256sum | cut -d' ' -f1)
echo "::add-mask::$CODE_RUNNER_TOKEN"
export CODE_RUNNER_TOKEN

# 运行函数只需要 node 可执行文件本身
RUNTIME_DIR=runner/code-runner/noderuntime
if [ ! -x "$RUNTIME_DIR/bin/node" ]; then
  curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz -o /tmp/runner-node.tar.xz
  mkdir -p "$RUNTIME_DIR/bin"
  tar -xJf /tmp/runner-node.tar.xz -C /tmp
  cp /tmp/node-v22.12.0-linux-x64/bin/node "$RUNTIME_DIR/bin/node"
fi
"$RUNTIME_DIR/bin/node" -v

# s 部署单个资源也会解析整份 s.yaml：其他资源引用、但本 job 没有的变量补成空串（只是占位，不进运行函数）
for name in $(grep -o "env('[A-Z0-9_]*')" s.yaml | sed "s/env('\(.*\)')/\1/" | sort -u); do
  [ -n "${!name+x}" ] || export "$name="
done

s irisCodeRunner deploy -y --access aliyun

pip install -q alibabacloud_fc20230330 >/dev/null 2>&1 || pip3 install -q alibabacloud_fc20230330 >/dev/null
URL=$(python3 - <<'PY'
import os
from alibabacloud_fc20230330.client import Client
from alibabacloud_tea_openapi import models as open_models
cfg = open_models.Config(access_key_id=os.environ['AK_ID'], access_key_secret=os.environ['AK_SECRET'],
                         endpoint=f"{os.environ['ACCOUNT_ID']}.cn-hangzhou.fc.aliyuncs.com")
fc = Client(cfg)
f = fc.get_function('iris-code-runner', None).body
print('internetAccess=%s role=%r vpc=%r' % (f.internet_access, f.role, getattr(f.vpc_config, 'vpc_id', None)), file=__import__('sys').stderr)
assert f.internet_access is False, 'iris-code-runner 必须关闭公网出站'
assert not f.role, 'iris-code-runner 不应绑定 RAM 角色'
ht = fc.get_trigger('iris-code-runner', 'httpTrigger').body.http_trigger
print(ht.url_internet.rstrip('/'))
PY
)
echo "iris-code-runner: $URL"

run() { curl -sS --max-time 40 -X POST "$URL/run" -H 'content-type: application/json' -H "x-runner-token: $CODE_RUNNER_TOKEN" -d "$1"; }
ok=0
for i in 1 2 3 4 5 6; do
  if curl -fsS --max-time 30 "$URL/health" -o /tmp/runner-health.json; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || { echo "运行函数没起来"; s irisCodeRunner logs --access aliyun || true; exit 1; }
cat /tmp/runner-health.json; echo

# 1) 不带令牌必须拒绝
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$URL/run" -H 'content-type: application/json' -d '{"code":"console.log(1)"}')
[ "$code" = 401 ] || { echo "无令牌调用返回 $code，应为 401"; exit 1; }
# 2) 正常运行 + TS
run '{"code":"console.log(1+1)"}' | tee /tmp/r1.json; echo
node -e 'const r=require("/tmp/r1.json"); if(r.exitCode!==0||r.stdout.trim()!=="2") process.exit(1)'
run '{"language":"typescript","code":"const n: number = 2; console.log(n ** 10)"}' | tee /tmp/r2.json; echo
node -e 'const r=require("/tmp/r2.json"); if(r.stdout.trim()!=="1024") process.exit(1)'
# 3) 隔离：环境变量为空、读不到系统文件、外网不通
run '{"code":"console.log(Object.keys(process.env).length)"}' | tee /tmp/r3.json; echo
node -e 'const r=require("/tmp/r3.json"); if(r.stdout.trim()!=="0") process.exit(1)'
run '{"code":"require(\"fs\").readFileSync(\"/proc/1/environ\")"}' | tee /tmp/r4.json; echo
node -e 'const r=require("/tmp/r4.json"); if(r.exitCode===0) process.exit(1)'
run '{"code":"fetch(\"https://www.baidu.com\",{signal:AbortSignal.timeout(4000)}).then(r=>console.log(\"NET_OK\",r.status),e=>console.log(\"NET_BLOCKED\",e.cause?.code||e.name))","timeoutMs":8000}' | tee /tmp/r5.json; echo
node -e 'const r=require("/tmp/r5.json"); if(r.stdout.includes("NET_OK")) { console.error("外网竟然能通"); process.exit(1) }'
# 4) 死循环被掐断
run '{"code":"for(;;){}","timeoutMs":1000}' | tee /tmp/r6.json; echo
node -e 'const r=require("/tmp/r6.json"); if(!r.timedOut) process.exit(1)'

echo "隔离冒烟全部通过"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "CODE_RUNNER_URL=$URL" >> "$GITHUB_ENV"
  echo "CODE_RUNNER_TOKEN=$CODE_RUNNER_TOKEN" >> "$GITHUB_ENV"
fi
