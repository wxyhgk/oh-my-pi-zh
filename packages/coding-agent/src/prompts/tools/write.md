在指定路径创建或覆盖文件。

<conditions>
- 任务明确要求创建新文件
- 当编辑比整体替换更复杂时,替换整个文件内容
- 支持通过 `archive.ext:path/inside/archive` 写入 `.tar`、`.tar.gz`、`.tgz`、`.zip` 及基于 ZIP 的 `.jar`/`.war`/`.ear`/`.apk` 归档条目
- 支持通过 `db.sqlite:table`(插入)、`db.sqlite:table:key`(用 JSON 内容更新,空内容删除)进行 SQLite 行操作
</conditions>

<critical>
- 修改现有文件时你应该使用 Edit 工具
- 除非被明确要求,你绝不创建文档文件(*.md、README)
- 除非被要求,你绝不使用 emoji
</critical>
