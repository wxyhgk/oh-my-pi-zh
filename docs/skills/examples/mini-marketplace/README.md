# mini-marketplace

一个最小的 `oh-my-pi` 市场目录,演示 `marketplace.json` 格式。它通过相对路径 source 列出一个插件(`my-plugin`)。

## 安装命令

```
/marketplace add ./docs/skills/examples/mini-marketplace
/marketplace install my-plugin@example-marketplace
```

或者通过 CLI:

```
omp plugin marketplace add ./docs/skills/examples/mini-marketplace
omp plugin install my-plugin@example-marketplace
```

## 它演示了什么

- `marketplace.json` 必备字段:`name`、`owner.name`、`plugins`
- 使用 `./` 前缀的相对路径插件 source(`"source": "./my-plugin"`)
- 插件与市场目录打包在同一个目录树中
- 额外的目录元数据:示例包含顶层 `description`;当前市场解析会保留额外的顶层字段,而运行时行为只使用必备字段和插件条目。

## 结构

```
mini-marketplace/
  .claude-plugin/
    marketplace.json      ← 目录
  README.md
  my-plugin/
    package.json          ← omp.extensions 清单
    index.ts              ← 扩展入口
```

已发布市场和本地市场使用相同的目录位置。omp 会先加载 `.omp-plugin/marketplace.json`,找不到时回退到市场根目录下的 `.claude-plugin/marketplace.json`(本示例携带的 Claude Code 兼容路径)。把 `/marketplace add` 指向此文件夹即可加载该示例。
