#!/usr/bin/env bash
# 部署项目实战在线试用的两个函数（project-trial-sandbox、project-trial-brain）并做冒烟。
# 成功后把入口地址和票据密钥写进 $GITHUB_ENV，供随后部署主函数时注入
# （PROJECT_TRIAL_URL / PROJECT_TRIAL_TICKET_SECRET）。任何一步失败都非零退出，
# 调用方据此不注入 → 主函数的 /project/trial/ticket 返回「暂时不可用」，不影响主函数部署。
# 前置：已 `s config add --access aliyun`；环境变量 SYNC_SECRET、LLM_API_KEY、AK_ID、AK_SECRET、ACCOUNT_ID。
set -euo pipefail

[ -n "${SYNC_SECRET:-}" ] || { echo "SYNC_SECRET 为空，无法派生试用函数的令牌"; exit 1; }
[ -n "${LLM_API_KEY:-}" ] || { echo "LLM_API_KEY 为空"; exit 1; }
# 令牌由已有 secret 单向派生，不新增 secret
PROJECT_TRIAL_SANDBOX_TOKEN=$(printf 'project-trial-sandbox:%s' "$SYNC_SECRET" | sha256sum | cut -d' ' -f1)
PROJECT_TRIAL_TICKET_SECRET=$(printf 'project-trial-ticket:%s' "$SYNC_SECRET" | sha256sum | cut -d' ' -f1)
echo "::add-mask::$PROJECT_TRIAL_SANDBOX_TOKEN"
echo "::add-mask::$PROJECT_TRIAL_TICKET_SECRET"
export PROJECT_TRIAL_SANDBOX_TOKEN PROJECT_TRIAL_TICKET_SECRET

# custom.debian10 自带的 Python 版本太旧，把独立的 Python 3.12 和 pytest 打进代码包
PY_DIR=runner/project-trial/pyruntime
if [ ! -x "$PY_DIR/bin/python3" ]; then
  pip install -q uv
  uv python install 3.12 --install-dir /tmp/trial-python
  # uv 会同时留一个 cpython-3.12-… 的软链指向带补丁号的真目录：只认真目录（-type d），
  # 否则拷过来的只是一个指向 /tmp 的软链，本机能跑、打进代码包却是空的
  SRC=$(find /tmp/trial-python -maxdepth 1 -type d -name 'cpython-3.12*-linux-x86_64-gnu' | head -1)
  [ -n "$SRC" ] && [ -x "$SRC/bin/python3.12" ] || { echo "没找到下载好的 Python 3.12"; exit 1; }
  rm -rf "$PY_DIR" && mkdir -p "$PY_DIR" && cp -a "$SRC/." "$PY_DIR/"
  # 可执行文件只留一份真文件 python3；python / python3.12 用两行脚本转过去，不依赖打包工具对软链的处理
  rm -f "$PY_DIR/bin/python3" "$PY_DIR/bin/python"
  mv "$PY_DIR/bin/python3.12" "$PY_DIR/bin/python3"
  for alias in python python3.12; do
    printf '#!/bin/sh\nexec "$(dirname "$0")/python3" "$@"\n' > "$PY_DIR/bin/$alias"; chmod +x "$PY_DIR/bin/$alias"
  done
  uv pip install --python "$PY_DIR/bin/python3" --break-system-packages pytest
  V=$(ls "$PY_DIR/lib" | grep '^python3\.' | head -1)
  rm -rf "$PY_DIR/lib/$V/test" "$PY_DIR/lib/$V/idlelib" "$PY_DIR/lib/$V/tkinter" "$PY_DIR/lib/$V/ensurepip" \
         "$PY_DIR/lib/$V/config-"* "$PY_DIR/include" "$PY_DIR/share" "$PY_DIR"/lib/*.a "$PY_DIR"/lib/libtcl* "$PY_DIR"/lib/libtk* "$PY_DIR"/lib/tcl* "$PY_DIR"/lib/tk* \
         "$PY_DIR/lib/$V/site-packages/pip"
  find "$PY_DIR" -name __pycache__ -type d -prune -exec rm -rf {} +
fi
"$PY_DIR/bin/python3" -c 'import sys, pytest; print("python", sys.version.split()[0], "pytest", pytest.__version__)'
du -sh "$PY_DIR"
[ ! -L "$PY_DIR" ] && [ "$(du -sm "$PY_DIR" | cut -f1)" -ge 20 ] || { echo "Python 运行时没有真正拷进代码包"; exit 1; }
if find "$PY_DIR" -type l -lname '/*' | grep -q .; then echo "Python 运行时里有指向包外的软链："; find "$PY_DIR" -type l -lname '/*' | head; exit 1; fi

# s 部署单个资源也会解析整份 s.yaml：其他资源引用、但本 job 没有的变量补占位值（只是占位，不进试用函数）
for name in $(grep -o "env('[A-Z0-9_]*')" s.yaml | sed "s/env('\(.*\)')/\1/" | sort -u); do
  [ -n "${!name:-}" ] || export "$name=unused"
done

pip install -q alibabacloud_fc20230330 >/dev/null 2>&1 || pip3 install -q alibabacloud_fc20230330 >/dev/null
fn_url() {  # $1 函数名  $2 期望的 internetAccess（True/False）
  FN="$1" EXPECT="$2" python3 - <<'PY'
import os, sys
from alibabacloud_fc20230330.client import Client
from alibabacloud_tea_openapi import models as open_models
from alibabacloud_fc20230330 import models as fc_models
cfg = open_models.Config(access_key_id=os.environ['AK_ID'], access_key_secret=os.environ['AK_SECRET'],
                         endpoint=f"{os.environ['ACCOUNT_ID']}.cn-hangzhou.fc.aliyuncs.com")
fc = Client(cfg)
name = os.environ['FN']
f = fc.get_function(name, fc_models.GetFunctionRequest()).body
print('%s internetAccess=%s role=%r vpc=%r' % (name, f.internet_access, f.role, getattr(f.vpc_config, 'vpc_id', None)), file=sys.stderr)
assert str(f.internet_access) == os.environ['EXPECT'], f'{name} 的公网出站设置不对'
assert not f.role, f'{name} 不应绑定 RAM 角色'
print(fc.get_trigger(name, 'httpTrigger').body.http_trigger.url_internet.rstrip('/'))
PY
}
wait_health() {
  for i in 1 2 3 4 5 6 7 8; do
    if curl -fsS --max-time 30 "$1/" -o /tmp/trial-health.json; then cat /tmp/trial-health.json; echo; return 0; fi
    sleep 5
  done
  return 1
}

# ── 1. 沙箱 ─────────────────────────────────────────────────────────────
s projectTrialSandbox deploy -y --access aliyun
SANDBOX_URL=$(fn_url project-trial-sandbox False)
echo "project-trial-sandbox: $SANDBOX_URL"
wait_health "$SANDBOX_URL" || { echo "沙箱函数没起来"; s projectTrialSandbox logs --access aliyun || true; exit 1; }

sx() { curl -sS --max-time 80 -X POST "$SANDBOX_URL/exec" -H 'content-type: application/json' -H "x-sandbox-token: $PROJECT_TRIAL_SANDBOX_TOKEN" -d "$1"; }
check() { python3 -c "import json,sys; r=json.load(open('$1')); sys.exit(0 if ($2) else 1)" || { echo "冒烟失败：$3"; cat "$1"; exit 1; }; }
# 不带令牌必须拒绝
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$SANDBOX_URL/exec" -H 'content-type: application/json' -d '{"files":{},"command":"echo 1"}')
[ "$code" = 401 ] || { echo "沙箱无令牌调用返回 $code，应为 401"; exit 1; }
# 能跑 pytest，文件变化能带回来
sx '{"files":{"test_a.py":"def test_a():\n    open(\"out.txt\",\"w\").write(\"1\")\n    assert 1 + 1 == 2\n"},"command":"python -m pytest -q test_a.py","timeout":40}' > /tmp/t1.json
check /tmp/t1.json "r['exit_code']==0 and '1 passed' in r['output'] and r['changed'].get('out.txt')=='1'" "pytest 没跑通"
# 隔离：看不到任何业务环境变量、外网不通、死循环被掐断
sx '{"files":{},"command":"env | wc -l; env | grep -ci -E \"token|secret|key\" || true"}' > /tmp/t2.json
check /tmp/t2.json "r['output'].split()[-1]=='0'" "沙箱里能看到密钥类环境变量"
sx '{"files":{"n.py":"import urllib.request as u\ntry:\n    u.urlopen(\"https://www.baidu.com\", timeout=4)\n    print(\"NET_OK\")\nexcept Exception as e:\n    print(\"NET_BLOCKED\", type(e).__name__)\n"},"command":"python n.py","timeout":15}' > /tmp/t3.json
check /tmp/t3.json "'NET_OK' not in r['output']" "沙箱外网竟然能通"
sx '{"files":{},"command":"while true; do :; done","timeout":2}' > /tmp/t4.json
check /tmp/t4.json "r['timed_out'] is True" "死循环没有被掐断"
echo "沙箱隔离冒烟通过"

# ── 2. 入口 ─────────────────────────────────────────────────────────────
export PROJECT_TRIAL_SANDBOX_URL="$SANDBOX_URL"
s projectTrialBrain deploy -y --access aliyun
BRAIN_URL=$(fn_url project-trial-brain True)
echo "project-trial-brain: $BRAIN_URL"
wait_health "$BRAIN_URL" || { echo "入口函数没起来"; s projectTrialBrain logs --access aliyun || true; exit 1; }
check /tmp/trial-health.json "r['configured'] is True" "入口函数配置不完整"
# 别的项目的试用场景是入口启动时加载的插件，加载失败只会少场景、不会让入口起不来，所以要单独查
check /tmp/trial-health.json "{'store', 'shop', 'evolve-prompt', 'evolve-config', 'campaign'} <= set(r['scenarios'])" "有试用场景没加载上"

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$BRAIN_URL/run" -H 'content-type: application/json' -d '{"ticket":"bad"}')
[ "$code" = 401 ] || { echo "入口无票据调用返回 $code，应为 401"; exit 1; }

# 真模型跑一遍示例任务：签一张票据，读完整条事件流
TICKET=$(python3 - <<'PY'
import base64, hashlib, hmac, json, os, time
body = base64.urlsafe_b64encode(json.dumps({"jti": "deploy-smoke-%d" % time.time(), "exp": int(time.time()) + 120, "scenario": "shop"}, separators=(",", ":")).encode()).decode().rstrip("=")
print(body + "." + hmac.new(os.environ["PROJECT_TRIAL_TICKET_SECRET"].encode(), body.encode(), hashlib.sha256).hexdigest())
PY
)
# 同时量首字节时间：流式生效时首字节应远早于结束；两者几乎相等说明响应被网关攒到最后才下发
curl -sS -N --max-time 220 -X POST "$BRAIN_URL/run" -H 'content-type: application/json' -d "{\"ticket\":\"$TICKET\",\"scenario\":\"shop\"}" \
  -o /tmp/trial-run.sse -w '%{time_starttransfer} %{time_total}\n' > /tmp/trial-timing.txt || true
read -r TTFB TOTAL < /tmp/trial-timing.txt || true
echo "首字节 ${TTFB:-?}s，全程 ${TOTAL:-?}s"
python3 -c "import sys; t,a=float(sys.argv[1]),float(sys.argv[2]); sys.exit(0 if t < max(5.0, a*0.5) else 1)" "${TTFB:-999}" "${TOTAL:-0}" \
  || echo "::warning::在线试用的事件流不是流式下发的（首字节太晚），页面会等到结束才一次性显示"
python3 - <<'PY'
import json, sys
events = [json.loads(l[6:]) for l in open('/tmp/trial-run.sse', encoding='utf-8') if l.startswith('data: ')]
kinds = [e['type'] for e in events]
tools = [(e['name'], e.get('denied'), (e.get('result') or '').splitlines()[0][:80] if e.get('result') else '') for e in events if e['type'] == 'tool_end']
print('事件数', len(events), '工具调用', len(tools))
for t in tools:
    print('  ', t)
done = next((e for e in events if e['type'] == 'done'), None)
err = next((e for e in events if e['type'] == 'error'), None)
if err or not done:
    print('试用运行没有正常结束：', err or kinds[-3:]); sys.exit(1)
fixed = any(c['path'] == 'shop/cart.py' for c in done['changed_files'])
passed = any(n == 'run_command' and r.startswith('[退出码 0]') for n, _, r in tools)
print('结束方式', done['stopped'], '轮次', done['turns'], '输入', done['input_tokens'], '输出', done['output_tokens'])
print('真模型结果：改了 cart.py =', fixed, '，测试全部通过 =', passed)
if done['stopped'] == 'model_error':
    print('模型接口不可用'); sys.exit(1)
PY

echo "在线试用冒烟通过"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "PROJECT_TRIAL_URL=$BRAIN_URL" >> "$GITHUB_ENV"
  echo "PROJECT_TRIAL_TICKET_SECRET=$PROJECT_TRIAL_TICKET_SECRET" >> "$GITHUB_ENV"
fi
