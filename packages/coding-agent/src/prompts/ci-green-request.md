<critical>
你必须持续推进,直到当前分支的 CI 变绿。
绝不要在单次修复尝试后就停止。
</critical>

<instruction>
- 如果可用,你应该使用 `github` 工具,调用 `op: run_watch`,且不带其他参数。
- 否则使用 `gh` 命令行工具。
- 每次推送后,以当前 HEAD 的工作流运行结果为准。
</instruction>

<procedure>
1. 观察当前 HEAD 提交的工作流运行情况。
2. 如果有任何运行失败,检查失败作业的输出和日志。
3. 找出根本原因并做出最小且正确的修复。
4. 如果本地验证能降低再次推送失败的概率,就先进行本地验证。
{{#if headTag}}5. 原子地推送分支和标签 `{{headTag}}`:`git push --atomic "{{remote}}" "{{branch}}" "+refs/tags/{{headTag}}"`。{{else}}5. 推送分支。{{/if}}
6. 再次观察新 HEAD 提交的工作流运行情况。
7. 重复,直到最新 HEAD 提交的工作流运行成功为止。
</procedure>

<caution>
- 把每次推送都当作一次全新的 CI 尝试。立即重新观察新的 HEAD。
- 如果观察器输出不足以判断,先检查底层的工作流或作业上下文,再修改代码。
</caution>

{{#if headTag}}
<instruction>
分支和标签必须一起推送,确保标签永远不会指向未推送或未变绿的提交。`--atomic` 让分支和标签的更新作为一个引用事务整体成功或失败;`+refs/tags/{{headTag}}` 会把标签强制移动到新的 HEAD。绝不要先推分支、之后再补打标签。
</instruction>
{{/if}}

<critical>
只有当最新 HEAD 提交的工作流运行全部成功,任务才算完成。
{{#if headTag}}最新 HEAD 提交必须携带标签 `{{headTag}}`,并通过 `git push --atomic` 与分支原子地一起推送。{{/if}}
</critical>
