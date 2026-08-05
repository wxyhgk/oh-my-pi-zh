# @oh-my-pi/pi-catalog

[oh-my-pi](https://github.com/can1357/oh-my-pi) 的模型目录:内置模型数据库、提供商发现、模型身份标识、分类与等价关系。

## 内含内容

| 模块                          | 用途                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `models.json` + `models`        | 内置模型数据库(定价、上下文窗口、模态、思考支持)                                                           |
| `provider-models`               | 提供商目录描述符(`CATALOG_PROVIDERS`)、按提供商的模型解析规则                                               |
| `discovery`                     | 针对 OpenAI 兼容端点、Gemini、Codex、Cursor、Antigravity、Ollama 的运行时模型发现                          |
| `identity`                      | 模型 id 解析与分类(家族/版本)、引用解析、等价关系、选择优先级                                               |
| `model-thinking`                | 思考/推理元数据与按模型生成的策略                                                                           |
| `model-manager` / `model-cache` | 带发现刷新与磁盘缓存的运行时模型注册表                                                                     |
| `variant-collapse`              | 折叠同一底层模型的不同提供商变体                                                                            |
| `compat`                        | 面向 OpenAI 与 Anthropic 形态 API 的请求/响应兼容性修正                                                     |
| `wire`                          | 线级辅助:Codex、Gemini 头、GitHub Copilot                                                                  |
| `effort`                        | 推理强度级别定义                                                                                            |

从子路径(`@oh-my-pi/pi-catalog/<module>`)或根 barrel 导入。

## models.json 是生成的

永远不要手改 `src/models.json`——它由 `scripts/generate-models.ts` 以及 `src/provider-models/` 中的解析器,根据上游来源(stencil.so、提供商目录发现、OpenCode 文档)生成。重新生成:

```sh
bun run gen:models
```

要修改条目,请修正来源:`provider-models/openai-compat.ts` 中的解析器覆盖、`provider-models/descriptors.ts` 中的提供商条目、`scripts/generate-models.ts` 中的生成器修正,或 `model-thinking.ts` 中的思考策略。

## 安装

```sh
bun add @oh-my-pi/pi-catalog
```

直接发布 TypeScript 源码(无构建步骤);要求 Bun ≥ 1.3.14。

## 参考

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
