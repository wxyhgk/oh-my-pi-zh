# @oh-my-pi/omp-stats

面向 AI 用量统计的本地可观测性仪表盘。

## 特性

- **会话日志解析**:读取 `~/.omp/agent/sessions/` 下的 JSONL 会话日志
- **SQLite 聚合**:使用 `bun:sqlite` 的高效统计存储与查询
- **Web 仪表盘**:基于 Chart.js 的实时指标可视化
- **增量同步**:只处理新增/修改的日志条目

## 追踪的指标

| 指标 | 计算方式 |
|--------|-------------|
| Tokens/s | `output_tokens / (duration / 1000)` |
| 缓存命中率 | `cache_read / (input + cache_read) * 100` |
| 错误率 | `count(stopReason=error) / total_calls * 100` |
| 总费用 | `usage.cost.total` 之和 |
| 平均延迟 | `duration` 的均值 |
| TTFT | `ttft`(首个 token 时间)的均值 |

## 用法

### 通过 CLI

```bash
# 启动仪表盘服务器(默认:http://localhost:3847)
omp stats

# 自定义端口
omp stats --port 8080

# 向控制台打印摘要
omp stats --summary

# 输出为 JSON(供脚本使用)
omp stats --json
```

### 编程方式

```typescript
import { getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats";

// 把会话日志同步进数据库
const { processed, files } = await syncAllSessions();

// 获取聚合统计
const stats = await getDashboardStats();
console.log(stats.overall.totalCost);
console.log(stats.byModel[0].avgTokensPerSecond);
```

## API 端点

| 端点 | 说明 |
|----------|-------------|
| `GET /api/stats` | 带全部细分的总体统计 |
| `GET /api/stats/models` | 按模型的统计 |
| `GET /api/stats/folders` | 按文件夹/项目的统计 |
| `GET /api/stats/timeseries` | 按小时的时间序列数据 |
| `GET /api/sync` | 触发同步并返回计数 |

## 数据存储

- **会话日志**:`~/.omp/agent/sessions/`(JSONL 文件)
- **统计数据库**:`~/.omp/stats.db`(SQLite)

## 仪表盘

Web 仪表盘提供:

- 总体指标卡片(请求数、费用、缓存命中率、错误率、时长、tokens/s)
- 显示请求与错误随时间变化的时间序列图
- 按模型细分表
- 按文件夹细分表
- 每 30 秒自动刷新

## 许可证

MIT
