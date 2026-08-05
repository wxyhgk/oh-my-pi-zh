按 id 编辑 Mnemopi 长期记忆。

只使用 `recall` 工具返回的 id。操作:
- `update`:替换工作记忆的内容和/或重要性。
- `forget`:永久删除一条工作记忆。
- `invalidate`:软性取代一条工作或情景记忆,可选地指向 `replacement_id`。

事实 id(`recall` 结果标记为 `[facts]`)是只读的:用 `read memory://<id>` 检查它们;对事实 id 的每个编辑操作都会返回 `not_editable`。

当一条记忆变得过时但其历史可能仍然有用时,优先 `invalidate`。只对应该硬删除的内容使用 `forget`。

**`update` 之前务必读取完整记忆。** `recall` 结果是截断的预览(尾随 `…` 标记截断,`full_length` 报告原始大小);`update` 会整体替换内容,所以覆盖预览会删除未见的尾部。先用 `read memory://<id>` 获取整行,然后把合并后的内容传给 `content`。
