执行下面不可变的安全计划。

仓库:{{repositoryRoot}}
目标类型:{{targetKind}}
修订版本:{{revision}}
基准修订:{{baseRevision}}
最新修订:{{headRevision}}
包含路径:{{includePaths}}
排除路径:{{excludePaths}}
知识库:{{knowledgeBases}}
计划指纹:{{planFingerprint}}
{{#if diffText}}

请求的基准到最新差异:

```diff
{{diffText}}
```
{{/if}}

首先盘点精确的范围。通过 `task` 把互不相交的审查任务委派给 `security-reviewer`。核对所有 worker 的输出,检查解决不确定性所需的任何证据,然后调用一次 `security_publish`,提交发现、诚实的覆盖报告和最终报告。
