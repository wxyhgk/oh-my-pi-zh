基于 op 的 `gh` 包装器:仓库、仓库文件、PR、搜索、检出、推送、Actions 观察。通过 `issue://<N>`/`pr://<N>` 读取 issue/PR。PR 差异:`pr://<N>/diff`(文件列表)、`pr://<N>/diff/<i>`(文件切片,从 1 开始)、`pr://<N>/diff/all`(完整差异)。

<instruction>
通过 `op` 选择操作。除了字段描述,每个 op:
- `repo_view` — 省略 `repo` 查看当前检出。
- `file_read` — 从 `repo` 读取 `path`;省略 `repo` 使用当前检出,省略 `branch` 使用其默认分支。
- `pr_create` — `head` 默认为当前分支。
- `pr_checkout` — 把 PR 检出到专门的 git 工作树,而不是你的工作树;传 `pr` 数组可在一次调用中批量处理多个。
- `pr_push` — 要求分支先通过 `op: pr_checkout` 检出。
- `search_issues`/`search_prs`/`search_commits`/`search_repos` — 当设置了 `since`/`until` 时 `query` 可选(仅日期筛选时省略它)。`search_code` 两者都不支持:`query` 必需,`since`/`until` 会被拒绝。
- `search_*` 默认 `repo` 为当前检出的 `owner/repo`;在 `query` 中传 `repo:`/`org:`/`user:` 限定符可搜索别处。`search_repos` 是例外——它忽略 `repo`;用 `query` 中的 `org:`/`language:` 限定符限定范围。
- `since`/`until` — 相对时长(`<n>` + `m`/`h`/`d`/`w`/`mo`/`y`,例如 `3d`、`2w`)、ISO 日期(`YYYY-MM-DD`)或 ISO 日期时间。`dateField: "updated"` 按更新时间(issues/PRs)或推送时间(仓库)筛选,而不是创建时间。
- `run_watch` — 省略 `run` 观察当前 HEAD 的每次运行(`branch` 回退到当前)。第一个作业失败时快速失败。
</instruction>

<output>
每个 op 的简洁摘要。`run_watch` 失败会把完整日志保存到会话产物。
</output>

<critical>
GitHub 托管的仓库文件?必须用 `file_read`;绝不 `curl`/`wget`。
</critical>
