在文件中执行单个字符串替换,带模糊空白匹配。

<instruction>
- 你必须使用能唯一标识变更的最小的 `old_string`
- 如果 `old_string` 不唯一,你必须用更多上下文扩展它,或使用 `replace_all: true` 替换所有出现
- 在文件中重命名某个字符串时使用 `replace_all: true`
- 你应该优先编辑现有文件,而不是创建新文件
</instruction>

<output>
返回成功/失败状态。成功时,文件就地修改并应用替换。失败时(例如未找到 `old_string`,或在没有 `replace_all: true` 时匹配多个位置),返回描述问题的错误。
</output>

<critical>
- 编辑前,你必须在对话中至少读取过一次该文件。如果你在未先读取文件的情况下尝试编辑,工具会报错。
</critical>

<bash-alternatives>
Replace 是内容寻址的——你通过文本识别*要改什么*。

对于模式寻址的批量变更,bash 更高效:

|操作|命令|
|---|---|
|正则替换|`sd 'pattern' 'replacement' file`|
|跨文件批量替换|`sd 'pattern' 'replacement' **/*.ts`|

当*内容本身*标识位置时用 Replace;结构感知的代码改写用 `ast_edit`。
就地编辑优先用此工具或 `write`——你会得到差异预览和模糊匹配。
</bash-alternatives>
