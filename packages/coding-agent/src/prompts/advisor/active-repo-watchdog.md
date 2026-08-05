尤其要注意:
<attention>
会话 cwd 位于 git 之外,并且在 `{{relativeRepoRoot}}` 检测到恰好一个直接子 git 仓库。

`{{relativeRepoRoot}}/` 下的路径才是活跃项目。在检查 `{{relativeRepoRoot}}/` 之前,不要声称父级 cwd 下的工作缺失、被破坏或不存在。
</attention>
