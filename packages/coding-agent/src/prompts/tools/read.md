通过 `path` 读取文件、目录、归档、SQLite、图像、文档、内部资源和网页 URL。

<instruction>
- 应该并行化独立的读取。
- 网页内容应该用 `read`(而不是 browser);只有 `read` 做不到时才用 browser。
</instruction>

## 选择器 — 在 `path` 后追加 `:<sel>`(例如 `src/foo.ts:50-200`、`src/foo.ts:raw`、`db.sqlite:users:42`)
- `:50` / `:50-` — 从第 50 行 | `:50-200` — 含两端 | `:50+150` — 从第 50 行起 150 行 | `:5-16,960-973` — 多个范围
- `:raw` — 原样,无锚点/前缀 | `:2-4:raw` / `:raw:2-4` — 范围 + 原样
- `:conflicts` — 每个未解决的 git 合并冲突块一行

## 来源种类
- 可解析代码,无选择器 → 结构摘要(仅声明,正文省略)。页脚命名恢复选择器——只重新发出那些范围。
- {{#if IS_HL_MODE}}文件 + 选择器 → `[foo.ts#1A2B]` 快照头 + 编号行。为锚定编辑复制 `[FILENAME#TAG]`;绝不编造该标签。{{/if}}
- 目录 → 深度受限的条目列表。
- SQLite(`.sqlite`、`.sqlite3`、`.db`、`.db3`):`file.db`(表)、`file.db:table`(schema+行)、`file.db:table:key`(按主键)、`?limit=`/`?where=`/`?q=SELECT`。
- 归档(`.tar`、`.tar.gz`、`.tgz`、`.zip`,以及基于 ZIP 的 `.jar`/`.war`/`.ear`/`.apk`):`archive.ext:path/inside/archive` 读取一个成员。
- 文档 → 提取的文本。笔记本 → 可编辑单元格。图像 → {{#if INSPECT_IMAGE_ENABLED}}元数据;调用 `inspect_image`{{else}}内联解码{{/if}}。`:raw` 绕过转换器。
- URL → 阅读器模式的干净文本/markdown;`:raw` → 未经处理的 HTML。裸 `host:port` 需要尾随斜杠。
- 内部 URI — 所有 scheme 都接受选择器。`artifact://<id>` 恢复溢出的输出;用 `:N-M`/`:raw:N-M` 翻页。
- `ssh://host/<path>` 读取远程文件/目录(UTF-8,≤1 MiB);裸 `ssh://` 列出主机;也可 `write`/`search`。
  字面 `:`、`?`、`#` → 百分号编码(`%3A`/`%3F`/`%23`)。需要 POSIX shell(否则用 `ssh` 工具)。

<critical>
摘要页脚点名了省略的范围?只重新发出那些范围。绝不猜测 `..`/`…` 的内容。
</critical>
