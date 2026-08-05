# @oh-my-pi/pi-utils

[oh-my-pi](https://github.com/can1357/oh-my-pi) 各包的共享工具。零仪式,Bun 优先。

## 主要模块

| 模块 | 用途 |
| --- | --- |
| `logger` | 写入 `~/.omp/logs/` 并带轮转的集中式日志器(TUI 安全——绝不输出到 stdout) |
| `prompt` | 基于 Handlebars 的提示词模板与格式化辅助 |
| `dirs` | omp 配置目录的路径辅助(`~/.omp`,Linux 上感知 XDG) |
| `stream` | 基于 `ReadableStream` 的 `readStream` / `readLines` 辅助 |
| `ptree` / `procmgr` | 进程树、`ChildProcess` 包装、进程生命周期管理 |
| `postmortem` | 退出、信号与致命异常时的清理回调 |
| `which` | 带缓存的 `$which()` 二进制查找 |
| `fetch-retry` | 带重试/退避策略的 `fetch` |
| `fs-error` | Errno 守卫(`isEnoent` 及其同类) |
| `env` / `worker-host` | 环境管道与无副作用 worker-host 入口契约(`workerHostEntry`) |
| `abortable` / `async` | 感知 AbortSignal 的流/承诺辅助 |
| `peek-file` | 用池化缓冲区读取文件前 N 字节 |
| `frontmatter`、`glob`、`mime`、`temp`、`format`、`color`、`snowflake`、`tab-spacing`、`path-tree`、`sanitize-text` | 更小的单用途辅助 |

从根 barrel 或按模块子路径(`@oh-my-pi/pi-utils/<module>`)导入。

## 安装

```sh
bun add @oh-my-pi/pi-utils
```

直接发布 TypeScript 源码(无构建步骤);要求 Bun ≥ 1.3.14。

## 参考

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
