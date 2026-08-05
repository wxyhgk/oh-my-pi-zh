# @oh-my-pi/pi-metaharness

一个统一管理仓库基准测试的 manager。Harbor、TypeScript edit 与 SnapCompact 运行使用相同的 experiment → run → trace 模型、SQLite 存储、REST/SSE API 和仪表盘。基准测试原生产物留在磁盘上;适配器把它们实时的进度、得分、token 用量、费用与 trace 规范化。

```bash
# 仪表盘 + API 位于 :4700;从同一个"新建运行"表单启动每一个基准测试
bun run serve --port 4700
```

## Harbor 运行如何执行

1. **本地 omp,不是 npm。** 默认情况下,runner 把仓库以只读方式 bind-mount 进每个任务容器(`--install source`),并直接从 `packages/coding-agent/src/cli.ts` 运行 omp——TS 修改无需重建即可应用到下一次试验。一个缓存的 linux `node_modules` 树(在 `oven/bun` 内、每次 lockfile 变化时构建一次,存放在 `<jobs-dir>/_bench/_deps/`)会遮蔽宿主的 darwin 版本;一个 linux `bun` 二进制被挂载到 `/opt/omp/bin`——因此试验设置零出站网络。替代方案:`--install local`(每次运行打包一个 tarball)或 `--binary`(预构建的 `dist/omp-linux-*` 自包含二进制)。
2. **认证从不进入容器。** 生成的 `models.yml` 把提供商的 `baseUrl` 路由到宿主 pm2 auth-gateway;网关在宿主侧解析凭证。
3. **Harbor 拥有试验。** runner/serve 层轮询每个试验的 `result.json`,获取进度、花费与结果。

## 服务器

- `GET /` — experiments、runs、规范化 traces,以及每个基准测试的启动表单。
- `GET /api/experiments[?q=]` — 跨所有基准测试类型的 experiment 摘要(`q` 按 id/goal 子串筛选)。
- `POST /api/experiments` — 在首个 arm 之前注册一个 experiment。请求体 `{ "id": "sb2", "goal": "..." }`;id 是无连字符的 token,任务名归组在其下(`sb2-n8` → experiment `sb2`)。
- `GET /api/experiments/:id` — arms、按任务矩阵与校准后的预估。
- `PUT /api/experiments/:id` — 更新 goal 与每次运行的 role/note/label。
- `POST /api/experiments/:id/arms` — 启动一个可比的 arm;sample 与 config 从同级 arm 继承。
- `DELETE /api/experiments/:id` — 删除所有 arm(数据库行**和**任务目录)以及 goal 行;任何 arm 运行中时拒绝。
- `GET /api/runs[?experiment=&status=&benchmark=]` — 统一的 run 行,含 benchmark、score、progress、spend 与 tokens。
- `POST /api/runs` — 通过基准测试适配器启动。请求体:

  ```json
  {
    "benchmark": "edit",
    "model": "anthropic/claude-opus-4-8",
    "tasks": 20,
    "concurrency": 4,
    "attempts": 2,
    "jobName": "edit-baseline",
    "role": "baseline",
    "goal": "compare edit strategies"
  }
  ```

  `benchmark` 为 `harbor`、`edit` 或 `snapcompact`。Harbor 使用 `dataset`、`include`、`timeoutMultiplier` 与 `prewalk`;edit 把 `include` 当作任务 id;SnapCompact 使用 `conditions`,并把 `tasks` 视为段落上限。
- `GET /api/runs/:name` — `{ run, traces }`(读取时同步原生产物)。
- `POST /api/runs/:name/cancel` — 取消一个由 manager 启动的运行。
- `DELETE /api/runs/:name` — 永久删除一个已完成的运行(数据库行**和**任务目录;幸存的目录会在重启时被重新发现);运行存活时拒绝。
- `POST /api/runs/:name/resume` — 就地恢复一个未完成的 harbor 运行:已完成的试验(及其花费)被复用,中断/挂起的试验重跑,出错的试验重试(请求体 `{ "filterErrorTypes": [...] }` 覆盖重试集合,默认是任务 `result.json` 中的每个异常类型)。runner 从 `_bench/<name>/runner-config.json`(启动时快照)或运行的 `manager.json` 恢复原始启动参数——无需重新指定任何东西。
- `GET /api/runs/:name/traces/:trace[?raw=1]` — 规范化或原生 trace。
- `GET /api/events` — run 列表快照的 SSE 流(变化时发送)。

状态存放在 `<jobs-dir>/_manager/metaharness.sqlite`;文件系统始终是事实来源,历史 CLI 运行会被自动发现。

## Harbor runner 选项(节选)

| 选项 | 默认值 | 说明 |
|---|---|---|
| `-m, --model <provider/model>` | `anthropic/claude-sonnet-4-6` | 可重复 |
| `-l, --tasks <N>` | `20` | 最大任务数 |
| `-n, --concurrency <N>` | `4` | 并发试验数 |
| `-k, --attempts <N>` | `1` | 每个任务的尝试次数(pass@k) |
| `-d, --dataset <name>` | `terminal-bench@2.0` | 任意 Harbor 数据集 id |
| `-i/-x, --include/--exclude <glob>` | — | 任务筛选(可重复) |
| `--timeout-multiplier <x>` | — | 缩放任务 agent/verifier 超时 |
| `--agent-arg <arg>` | — | 原样转发给容器内 omp CLI 的额外参数(可重复) |
| `--env <KEY[=VALUE]>` | — | 把 env 转发进 omp 容器(可重复);单独的 `KEY` 转发宿主值 |
| `--binary <path>` | — | 预构建 omp 二进制(arm64+x64 可重复) |
| `--install <source\|local\|published>` | `source` | `source` = 仓库 bind-mount,`local` = tarball 打包,`published` = npm `@oh-my-pi/pi-coding-agent` |
| `--environment <docker\|apple-container>` | `docker` | `apple-container` 通过 Apple 的 `container` CLI 运行试验(无 Docker);source/deps 挂载走 `harbor --mounts`,gateway 从 `192.168.64.1:4000` 自动转发到 loopback 绑定的 gateway |
| `--gateway-url <url>` | `http://host.docker.internal:4000` | `--environment apple-container` 下为 `http://192.168.64.1:4000` |
| `--no-gateway` | 关 | 改为把宿主提供商密钥传入容器 |
| `-o, --jobs-dir <path>` | `<repo>/runs/harbor` | 与服务器共享 |
| `--resume <name\|path>` | — | 通过 `harbor job resume` 恢复该任务目录;原始参数自动恢复 |
| `--filter-error-type <T>` | `CancelledError` | 配合 `--resume`:额外重跑以异常类型 `T` 出错的已完成试验(可重复) |
| `--dry-run` | 关 | 打印 harbor 命令 + models.yml 后退出 |

## 输出

- `<jobs-dir>/<jobName>/` — Harbor 试验目录(每个试验一个 `result.json`)。
- `<jobs-dir>/_bench/<jobName>/report.md` — markdown 摘要表。
- `<jobs-dir>/_bench/<jobName>/harbor.log` — 完整 Harbor 输出。
- `<jobs-dir>/_manager/logs/<jobName>.log` — API 启动的运行的 runner 输出。

## Trace 报告

`scripts/trace-report.ts` 把一条运行 trace 变成叙述性 markdown 报告(编号的 Turn Log,每个 assistant 轮次一句有依据的话,harness 提示原位保留,然后是 Story Arc,失败运行还带失败分析)。它通过两个廉价的 OpenRouter 模型对规范化 trace 做 map/reduce(默认:每轮 `inclusionai/ling-2.6-flash`,arc 用 `openai/gpt-oss-120b`;每份报告约 $0.001)。API 密钥通过 omp 的 auth 存储解析。

```bash
bun scripts/trace-report.ts <run> <trace> [--focus "reviewer notes"] [--out report.md]
bun scripts/trace-report.ts "sb3-ntg|django__django-12325__ddQroP4"   # run|trace 也接受
```

标志:`--base`(服务器,默认 `http://localhost:4700`)、`--tiny` / `--synth`(`<provider>/<model-id>` 覆盖)、`--focus`(额外的 reviewer 上下文,例如失败任务的已知正确修复)、`--concurrency`(默认 8)。

## 注意事项

- **网络策略。** 在 Harbor 的本地 Docker 后端上只有**公共**注册表可用;任务容器通过宿主 gateway 触达模型。
- **`--install source` 无需重建即可反映本地 TS 修改**,但 Rust natives 从树内 `packages/natives/native/pi_natives.linux-*.node` 预构建加载——Rust 变化时请重建它们(加载器对 workspace 加载跳过版本哨兵,因此过期的 `.node` 会静默运行)。
- **Source 模式是单架构的。** deps 树匹配 docker daemon 的原生架构;在模拟镜像上的试验(例如 arm64 宿主上的 x64 任务)会以架构不匹配错误在设置阶段失败——这类情况请用 `--binary`。
- **source 模式下,仓库在任务容器内可见(只读)**;对精选基准测试没问题,但别指向不可信任务。
- **Apple Container 细节。** `--environment apple-container` 需要 `brew install container && container system start`(macOS 26+,Apple 芯片)。`--host-network` 与 `--cleanup*` 仅限 docker,bind 挂载是读写(后端忽略 `read_only`)。
- **`--install local` 反映本地 TS 修改**(内联进 `dist/cli.js`),但**不**反映未提交的 Rust natives——请先按目标重建 `packages/natives`(版本哨兵必须匹配)。
