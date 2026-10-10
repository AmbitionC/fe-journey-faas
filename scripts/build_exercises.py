"""把 hasaneyldrm/exercises-dataset 的动作数据瘦身成后端可直接 import 的 TS 模块。

用法：python3 -I scripts/build_exercises.py <exercises-dataset 克隆目录>
输出：src/service/health/training/exercises.data.ts

只取 MIT 许可的数据部分（名称/部位/器械/目标肌群/协同肌群/中文分步说明）。
动图与缩略图 © Gym visual，不随本仓库分发——只记文件名，前端以链接形式跳到原仓库查看。
"""
import json
import subprocess
import sys
from pathlib import Path

src = Path(sys.argv[1])
rows = json.loads((src / "data" / "exercises.json").read_text(encoding="utf-8"))
commit = subprocess.run(["git", "-C", str(src), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()

out = []
for x in rows:
    name = x["name"].replace("в°", "°").strip()  # 上游少量名称有编码错误
    out.append({
        "id": x["id"],
        "name": name,
        "part": x["category"],
        "eq": x["equipment"],
        "target": x["target"],
        "sec": x["secondary_muscles"],
        "steps": x["instruction_steps"]["zh"],
        "gif": Path(x["gif_url"]).name,
    })
out.sort(key=lambda r: r["id"])

dst = Path(__file__).resolve().parents[1] / "src" / "service" / "health" / "training" / "exercises.data.ts"
body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
dst.write_text(
    "/* eslint-disable */\n"
    "// 自动生成，勿手改：python3 -I scripts/build_exercises.py <exercises-dataset>\n"
    f"// 数据来源：https://github.com/hasaneyldrm/exercises-dataset @ {commit}（数据部分 MIT，© Hasan Emir Yıldırım）\n"
    "// 动图/缩略图 © Gym visual — https://gymvisual.com/ ，不随本仓库分发，只保留文件名用于外链。\n"
    "import type { ExerciseRow } from './types';\n\n"
    f"export const EXERCISES: ExerciseRow[] = {body};\n",
    encoding="utf-8",
)
print(f"{len(out)} 条 → {dst}（{dst.stat().st_size // 1024} KB）")
