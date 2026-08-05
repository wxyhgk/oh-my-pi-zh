Agent 协调:同行消息、后台作业控制和受监管的长时间运行进程。主 Agent 是 `Main`;子 Agent 继承任务 ID。
用 `op: "list"` 发现同行。按确切的花名册 ID 称呼同行——绝不发明名字。

# 消息与作业

后台作业完成时自动交付。你绝不需要轮询;如果 `jobs`/`wait` 先观察到已落定的作业,那个快照就是交付,并抑制重复的 `async-result`。

- **`send`**(配合 `to`):发后即忘,绝不阻塞。投递回执(`delivered`/`failed`)立即返回;`failed` → 同行已离开,不要重试。
  发送会唤醒 `idle`/`parked` 的同行。回答时:先给答案,绝不引用,设置 `replyTo`。
- **格式**:只用纯散文。不要 JSON 状态对象。通过 `local://`/`artifact://` URL 分享路径,而不是粘贴大块文本。
- **`wait`**:只在完全被阻塞、没有其他工作可做时使用。在以下**第一个**发生时返回:收到消息、被观察的作业完成、等待窗口到期,或转向中断——不是在所有作业完成时;重新发出以继续等待。
  - 裸 `wait` 观察每个运行中的作业**和**收到的消息。绝不传一个包含所有运行 ID 的数组;`ids` 收窄到特定作业,`from` 收窄到某个同行(或在 send 上用 `await: true`)。
- **`inbox`**:不阻塞地排空排队消息。
- **`cancel`**:当后台作业挂起、停滞或不再需要时,按 `ids` 杀掉它们。立即返回。
- **`jobs`**:不等待地快照每个作业的状态。已落定的行会消耗自动交付。也会点名没有作业条目的运行中子 Agent——用 `send` 与它们协调。
- 作业行是进程本地的,落定后大约五分钟过期。之后,用 `send`、`agent://<id>` 或 `history://<id>` 加上 Agent ID。
- `completed` 意味着成功的 yield/作业退出,不是产物验收。核实声称的变更。
- 绝不用 shell 工具、grep 或读取其他会话的文件来弄清同行在做什么。直接给它们发消息。
- 绝不用 hub 消息做工具能回答的事(例如 grep 代码库、运行构建)。

# 进程

项目范围内的长时间运行进程,由同一目录中的每个 omp 实例共享。需要稍后输入的服务、监视器、调试器、REPL 或进程必须使用 `op:"start"`,而不是 `bash`。

- **`start`** 直接启动 `application` + `args`。`cwd` 默认为会话目录;`pty` 默认为 true。
  - `ready.log` 是正则;`ready.port` 是 TCP 端口。两者都提供?两者都必须通过。`ready.timeout` 是秒。就绪必须被观察到;仅创建进程不算就绪。
  - 名字在每个项目目录中唯一。已完成的名称可以再次启动;活跃的名称必须停止或重启。
  - `restart` 策略默认为 `no`;`on-failure` 和 `always` 使用有界退避。
  - `persist: true` 选择退出 last-omp 拆除;`detached: true` 在 broker 关闭和所有 omp 退出后仍存活(隐含 persist,禁用 PTY 输入)。除非需要它们的存活保证,否则两者都省略。
- **`ps`**、**`logs`**、**`wait`**(配合 `name`)、**`send`**(配合 `name`)、**`stop`**、**`restart`** 和 **`describe`** 指向稳定的 `name`。
- **`logs`** 默认为最后 100 行。`head: true` 从头读取。`grep` 是正则。`follow: true` 在 `cursor` 之后等待输出;在下次调用中复用返回的 cursor。
- **`wait`** 配合 `name` 阻塞直到就绪/退出/`pattern` 或 `timeout`(秒)。
- **`send`** 配合 `name`:`text` 写入 stdin(`enter` 默认为 true);`keys` 支持 ENTER、TAB、ESCAPE、CTRL_C、CTRL_D、UP、DOWN、LEFT、RIGHT;`signal` 支持 SIGINT、SIGTERM、SIGHUP、SIGQUIT、SIGKILL。PTY 输入是串行化的;写入共享一个输入流。
- **`stop`** 在硬杀之前执行优雅的进程树终止;绝不通过 bash 杀掉未经核实的 PID。**`restart`** 复用保留的启动规格。
