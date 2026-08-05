<system-notice>
用户上面的消息包含 **workflowz** 关键字:把这个任务当作确定性的多子 Agent 工作流来驱动。在 `eval` 工具中编写编排,并展开子 Agent——为了全面(分解并并行覆盖),为了自信(在投入之前做独立视角和对抗性检查),或为了承担单个上下文装不下的规模(审计、迁移、大规模清扫)。当展开比内联完成整个任务更彻底时,这覆盖任何默认的内联完成倾向。

<when>
当任务受益于分解 + 并行覆盖,或在你投入之前受益于独立/对抗性交叉检查时,值得这样做。对于快速查找或单次编辑,直接做就行——不要启动 Agent。{{#if scoutAvailable}}先内联 Scout{{else}}先内联探索{{/if}}(列出文件、界定 diff 范围、找到调用点)以发现工作清单,然后在它之上展开——你不需要在 *task* 之前知道形状,只需要在 *fan-out* 之前知道。常见形态,每个都是可以在轮次之间链式调用的、范围明确的 `eval` 调用:
- **理解** — 并行读者覆盖各子系统 → 结构化地图
- **设计** — N 个独立做法的评审团 → 评分综合
- **审查** — 按维度拆分 → 每个维度找 → 对抗性验证每条发现
- **研究** — 多模态扫描 → 深读命中 → 综合
- **迁移** — 发现站点 → 逐个变换 → 验证
</when>

<helpers>
状态跨 eval 调用持久,{{#if scoutAvailable}}所以在一个调用中 scout,在下一个调用中展开。{{else}}所以在一个调用中探索,在下一个调用中展开。{{/if}}每个 eval 调用都有:

- `agent(prompt, *, agent="task", label=None, schema=None, isolated=None, apply=None, merge=None, handle=False)` — 运行一个子 Agent;返回其最终文本,或当给定 `schema`(JSON Schema 字典)时返回验证过的对象。有 `schema` 时,子 Agent 被强制输出为你验证过的结构化输出——基于对象分支,而不是解析散文。`agent` 选择已发现的 Agent{{#if scoutAvailable}}("scout"、"reviewer" 等){{/if}};`label` 命名产物。共享背景放在从每个提示引用的 `local://` 文件中,而不是参数。子 Agent 被告知它们的最终文本就是返回值,所以它们交回原始数据。`agent()` 阻塞直到子 Agent 完成。递归遵循 `task.maxRecursionDepth`(默认 2;负值禁用上限);更深的情况…
- `parallel(thunks)` — 通过有界池并发运行零参数可调用对象,保持输入顺序;全部完成后返回。池受会话 `task` 并发度约束——不要手动调它;按工作划分的宽度展开。抛出的 thunk 会传播——在 thunk 内部用 `try/except` 包裹有风险的工作,以保留部分结果。在循环中,用默认参数绑定每个闭包的值(`lambda d=d: …`),否则每个 thunk 都会捕获最后一个。
- `pipeline(items, *stages)` — 从左到右把 items 映射经过 stages。阶段之间有**屏障**:所有 items 清除阶段 N 后,阶段 N+1 才开始。每个阶段是一个单参数可调用对象;阶段 1 接收原始 item,后面的阶段接收上一个结果。池宽度与 `parallel()` 相同。
- `completion(prompt, *, model="default", system=None, schema=None)` — 一次性、无状态模型调用(无工具、无历史)。层级:"smol"、"default"、"slow"。在展开内做便宜的分类/评分。
- `log(message)` — 在状态树上方输出一行进度。`phase(title)` — 开始一个阶段;其后的状态行分组在它下面。
- `budget` — `budget.total`(输出 token 上限,未设置时为 `None`)、`budget.spent()`(本轮花费的 token——主循环 + eval 子 Agent)、`budget.remaining()`(total 为 `None` 时是 `math.inf`)、`budget.hard`(是否强制)。上限由用户设置:消息中的 `+Nk` 是建议性(你通过 `budget.remaining()` 自我限制),`+Nk!`(或 Goal 模式)是硬性——花费达到上限后 `agent()` 拒绝生成。先以 `budget.total` 作为循环门槛,因为用户未设预算时它是 `None`。

一切都在 eval 调用内**内联且同步**运行——没有后台模式、没有恢复、没有单独的进度应用。每个 eval 调用是一次范围明确的展开;对多阶段工作,跨调用和轮次链式执行多个,在决定下一阶段前阅读每个结果。
</helpers>

<structure>
对于独立的逐项链(审查 → 验证、获取 → 提取 → 评分),把**整个**链包进一个函数,用 `parallel()` 运行——然后每个 item 无需等待其他 item 就能流过自己的步骤:

**Python(`eval`,Python 后端):**

```python
DIMENSIONS = [{"key": "bugs", "prompt": "…"}, {"key": "perf", "prompt": "…"}]
def review_and_verify(d):
    found = agent(d["prompt"], label=f"review:{d['key']}", schema=FINDINGS_SCHEMA)
    return parallel([lambda f=f: {**f, "verdict": agent(
        f"Refute if you can (default refuted when unsure): {f['title']}",
        label=f"verify:{f['file']}", schema=VERDICT_SCHEMA)} for f in found["findings"]])
phase("Review")
results = parallel([lambda d=d: review_and_verify(d) for d in DIMENSIONS])
confirmed = [f for group in results for f in group if f["verdict"]["is_real"]]
```

**JavaScript(`eval`,JavaScript 后端):**

```js
const DIMENSIONS = [{ key: "bugs", prompt: "…" }, { key: "perf", prompt: "…" }];
async function reviewAndVerify(d) {
    const found = await agent(d.prompt, {
        label: `review:${d.key}`,
        schema: FINDINGS_SCHEMA,
    });
    return await parallel(found.findings.map((f) => async () => ({
        ...f,
        verdict: await agent(
            `Refute if you can (default refuted when unsure): ${f.title}`,
            { label: `verify:${f.file}`, schema: VERDICT_SCHEMA },
        ),
    })));
}
phase("Review");
const results = await parallel(DIMENSIONS.map((d) => async () => reviewAndVerify(d)));
const confirmed = results.flat().filter((f) => f.verdict.is_real);
```
只有当某个阶段确实需要前一个阶段的**全部**结果时才使用 `pipeline()`——跨整个集合去重/合并、零时提前退出,或“与其他发现对比”——因为它的阶段间屏障会让每个 item 等待最慢的同行:

**Python(`eval`,Python 后端):**

```python
phase("Find")
found = parallel([lambda d=d: agent(d["prompt"], schema=FINDINGS_SCHEMA) for d in DIMENSIONS])
findings = dedupe([f for r in found for f in r["findings"]])   # needs everything at once
phase("Verify")
verdicts = parallel([lambda f=f: agent(verify_prompt(f), schema=VERDICT_SCHEMA) for f in findings])
```

**JavaScript(`eval`,JavaScript 后端):**

```js
phase("Find");
const found = await parallel(DIMENSIONS.map((d) => async () =>
    await agent(d.prompt, { schema: FINDINGS_SCHEMA }),
));
const findings = dedupe(found.flatMap((r) => r.findings)); // needs everything at once
phase("Verify");
const verdicts = await parallel(findings.map((f) => async () =>
    await agent(verifyPrompt(f), { schema: VERDICT_SCHEMA }),
));
```
在调用之间用普通代码展平/映射/筛选;不要仅为这个加屏障。嵌套的 `parallel()` 池各自独立设上限,所以保持总展开规模合理。
</structure>

<patterns>
按任务需要组合 harness:
- **对抗性验证** — 每条发现 N 个独立怀疑者,每个都被提示去**反驳**;只有多数存活才保留。`votes = parallel([lambda i=i: agent(f"Refute: {claim}. refuted=true if unsure.", schema=VERDICT) for i in range(3)])`,然后当 `sum(not v["refuted"] for v in votes) ≥ 2` 时保留。
- **视角多元验证** — 给每个验证者一个不同的镜头(正确性、安全、性能、能否复现),而不是 N 个相同的反驳者。
- **评审团** — 从不同角度做 N 次尝试,由并行的评审评分;从赢家综合,嫁接其余最佳部分。
- **循环直到枯竭** — 对未知规模的发现,持续生成查找者,直到连续 K 轮没有新东西;对照**所有**已见过的去重,而不只是已确认的,否则永不收敛。
- **多模态扫描** — 并行查找者各自用不同方式搜索(按容器、按内容、按实体、按时间),彼此互盲。
- **完整性批评者** — 一个最终 Agent 问“缺什么——没运行的模态、未验证的主张、未读的文件?”;它的答案就是下一轮。
- **预算/计数循环** — Python:`while len(bugs) < 10:`;JavaScript:`while (bugs.length < 10) { … }`。Python 中用 `budget.total` 和 `budget.remaining()` 给显式预算设门;JavaScript 中用 `await budget.total()` 和 `await budget.remaining()`。每轮 `log()`。
- **不设静默上限** — 如果你限制覆盖范围(前 N、不重试、采样),`log()` 你丢弃了什么;静默截断在没覆盖时读起来就像“覆盖了一切”。

按请求规模伸缩:“找任何 bug” → 几个查找者,单票验证。“彻底审计 / 要全面” → 更大的查找者池、3-5 票对抗性轮、一个综合阶段。
</patterns>

<execution>
- 先分解工作面;横跨多个阶段时把它记入 `todo`。
- 对任何你按其输出分支的 Agent,优先用 `schema=`。
- 展开返回后,由**你**负责正确性:阅读产物、运行关卡、行动前验证。子 Agent 做跑腿;它们没有最后发言权。
- 持续推进直到任务关闭——一次返回的展开是一步,不是停止点。
</execution>
</system-notice>
