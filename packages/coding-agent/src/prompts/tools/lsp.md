来自语言服务器的符号感知代码智能——在文本工具漏掉调用点的导航、重构和诊断。

<operations>
- 基于位置:`file` + `line` + `symbol`(子串;`#N` 表示第 N 个匹配)。`line` 从 1 开始。
- `rename` — 默认应用;`apply: false` 预览。项目感知的查找在没有 `symbol` 时会报错——缺失/有歧义的匹配不会静默回退。
- `code_actions` — 默认列出;用 `apply: true` + `query`(标题子串或索引)应用一个。
- `rename_file` — 移动文件并重写所有导入/引用;默认应用。
- `diagnostics` — 路径、glob(`src/**/*.ts`),或 `file: "*"` 表示整个工作区。
- `symbols` — `file` 列出文件符号;`file: "*"` + `query` 搜索工作区。
- `reload` — 重启一个服务器(`file`)或全部(`*`);`reload *` 重新读取 LSP 配置。
- `request` — 原始:`query` = 方法,`payload` = JSON 参数(否则自动构建)。
</operations>

<critical>
- 只要服务器可用,符号感知的工作(rename、references、definition、code actions)必须使用 `lsp`。
  它能跟随文本工具漏掉的遮蔽、再导出和跨文件用法。
- 当 `lsp` 的 `rename`/`rename_file` 能做到时,绝不用 `ast_edit`/`sed`/手动编辑做跨文件重命名——文本重命名会静默丢掉调用点。
- 在手动编辑之前,对导入、快速修复和服务器已知的重构,优先用 `code_actions`。
</critical>
