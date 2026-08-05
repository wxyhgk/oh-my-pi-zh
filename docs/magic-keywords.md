# 魔法关键词

魔法关键词是用户提示词中独立出现的散文式词语，可以为该轮次添加隐藏的、归属于用户的指令。注入提示（notice）默认启用。TUI 在编辑时以动态渐变高亮识别出的关键词，已发送的消息中则以静态渐变显示；高亮是一种视觉提示，即使设置中禁用了提示注入，目前仍会保留。

## 关键词

| 关键词         | 效果                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ultrathink`  | 添加一条谨慎的多步推理提示。当自动思考处于活动状态时，它还会为该轮次选择当前模型支持的最高推理强度。                                                                                                                                                                                                                 |
| `orchestrate` | 添加多 Agent 编排契约：规划完整任务，并行委派大量独立工作，验证每个阶段，并持续执行直到请求完成。                                                                                                                                                                                                                       |
| `workflowz`   | 添加一个确定性的多子 Agent 工作流契约，围绕持久化 `eval` 内核的 `agent()`、`parallel()`、`pipeline()` 和 `completion()` 辅助函数构建。它适用于广泛的研究、审查、迁移和对抗性覆盖场景。只有在 `eval` 和 `task` 都处于活动状态时，才会注入该提示。 |

在提示词散文的任何位置使用关键词：

```text
ultrathink about the failure modes before changing this API

orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes
```

## 匹配规则

匹配是刻意设计的，以免源代码和路径意外改变 Agent 行为：

- 使用精确的小写拼写。`Ultrathink`、`Orchestrate` 和 `Workflowz` 不会触发。
- 关键词必须是独立的散文词。句末标点和引号可以紧贴它，但字母、数字、下划线、斜杠、反斜杠、连字符、文件扩展名、符号引用和调用语法都不匹配。例如 `orchestrate,` 匹配；`orchestrated`、`orchestrate.ts`、`foo::orchestrate` 和 `orchestrate()` 不匹配。
- 代码围栏（反引号或波浪号）、内联代码片段、HTML/XML 注释/标签/元素及其内容均被忽略。
- 一条提示词中所有启用的关键词都可以添加各自的提示。可见的词仍保留在用户消息中；隐藏的提示是不显示的、归属于用户的自定义消息。
- 该指令仅适用于包含关键词的那一轮次。

## 配置

打开 `/settings` 并使用 **交互 → 魔法关键词**，或从 shell 更改设置：

```bash
# 禁用所有魔法关键词
omp config set magicKeywords.enabled false

# 禁用某一个关键词，同时保留其他关键词启用
omp config set magicKeywords.ultrathink false
omp config set magicKeywords.orchestrate false
omp config set magicKeywords.workflow false
```

全局开关和三个按关键词设置的开关默认均为 `true`。全局开关控制所有隐藏提示；按关键词设置的开关只控制对应提示（以及 ultrathink 的最大自动思考覆盖）。这些设置目前不会禁用编辑器/消息渐变。运行 `omp config list` 可查看每个设置及其当前值。参见[设置](./settings.md)了解配置作用域、优先级和项目级覆盖。
