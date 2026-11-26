"""第四级进化：让模型改外壳代码（Meta-Harness 的思路）。

这里的外壳代码是一个很小的钩子模块（transform_result），在工具结果交给模型之前加工它。
比前三级多两道检查：静态检查（不能 import 别的、不能碰文件和网络）和试跑。
通过之后和其他级别一样过准入闸门。
"""
from __future__ import annotations

from ..harness import DEFAULT_CODE, smoke_code
from ..types import AgentVersion
from .common import example_block, extract_block
from .gate import Bench, Decision, admit, reject

SYSTEM = "你在改进一个编程 Agent 的外壳代码。你只能修改一个 Python 钩子函数。"
TEMPLATE = """Agent 每次调用工具后，结果会先经过下面这个函数再交给模型：

<code>
{code}
</code>

约定：
- 签名固定为 transform_result(name, args, result) -> str。name 是工具名
  （read_file / write_file / edit_file / find_files / search_text / run_command），args 是参数字典，result 是原始结果。
- 只允许 import re、json、textwrap。不能读写文件、不能访问网络、不能用 exec/eval/open。
- 不能把非空结果变成空的；出错的结果要保留错误信息本身。

下面是 Agent 在进化集上的几次失败：

{examples}

历史上被拒绝的修改：
{rejected}

想一想：这些失败里，有没有哪一类是因为模型“没看到”或“没注意到”工具结果里的关键信息？
如果有，改写这个函数让关键信息更显眼（例如把测试输出里的断言失败行提到最前面、
在超长输出里保留报错部分）。如果这些失败和工具结果的呈现方式无关，原样抄回当前代码。

按下面的格式输出：
<rationale>一两句话：改了什么，预期解决哪类失败</rationale>
<code>完整的新代码</code>"""


async def evolve_code(bench: Bench, model, current: AgentVersion) -> tuple[AgentVersion, Decision | None]:
    evolve_set = bench.split("evolve")
    tasks = {t.id: t for t in evolve_set}
    records = await bench.run(current, evolve_set, "基线·进化集")
    failures = [r for r in records if not r.passed]
    if not failures:
        bench.notify("note", {"text": "进化集已全部通过，没有可分析的失败"})
        return current, None
    code = current.code or DEFAULT_CODE
    text = await model.ask(SYSTEM, TEMPLATE.format(
        code=code, examples="\n\n".join(example_block(tasks[r.task_id].prompt, r) for r in failures[:4]),
        rejected="\n".join(f"- {x}" for x in bench.store.rejected_notes()) or "（无）") + bench.limits())
    new_code = extract_block(text, "code").strip() + "\n"
    rationale = extract_block(text, "rationale").strip()
    changed = bool(new_code.strip()) and new_code.strip() != code.strip()
    bench.notify("proposal", {"level": 4, "rationale": rationale, "changed": changed})
    if not changed:
        return current, None

    candidate = current.derive(f"外壳代码：{rationale[:80]}", code=new_code)
    errors = smoke_code(new_code)
    if errors:
        return current, reject(bench, candidate, current, "代码没有通过检查：" + "；".join(errors), "unsafe")
    decision = await admit(bench, candidate, current)
    return (candidate if decision.admitted else current), decision
