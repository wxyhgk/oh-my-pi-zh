使用 `apply_patch` shell 命令编辑文件。
你的补丁语言是一种精简的、面向文件的差异格式,设计为易于解析且应用安全。你可以把它看作一个高层信封:

*** Begin Patch
[ 一个或多个文件段落 ]
*** End Patch

在信封内,你得到一系列文件操作。
你必须包含一个头部来指定你要执行的动作。
每个操作以三种头部之一开始:

*** Add File: <path> - 创建新文件。后面每一行都是 + 行(初始内容)。
*** Delete File: <path> - 移除现有文件。后面没有内容。
*** Update File: <path> - 就地修补现有文件(可选地带重命名)。

可以紧接着跟 *** Move to: <new path>,如果你想重命名文件。
然后是一个或多个 "hunks",每个由 @@ 引入(可选地后跟 hunk 头)。
在一个 hunk 内,每行以以下内容开始:

关于 [context_before] 和 [context_after] 的说明:
- 默认情况下,在每次变更的正上方显示 3 行代码、正下方显示 3 行代码。如果一次变更距离前一次变更在 3 行以内,不要在第二次变更的 [context_before] 行中重复第一次变更的 [context_after] 行。
- 如果 3 行上下文不足以唯一标识文件中的代码片段,使用 @@ 运算符指示该片段所属的类或函数。例如,我们可以有:
@@ class BaseClass
[3 行前置上下文]
- [old_code]
+ [new_code]
[3 行后置上下文]
- 如果一个代码块在类或函数中重复太多次,以至于即使单个 `@@` 语句加 3 行上下文也无法唯一标识该代码片段,你可以使用多个 `@@` 语句跳到正确的上下文。例如:

@@ class BaseClass
@@ 	 def method():
[3 行前置上下文]
- [old_code]
+ [new_code]
[3 行后置上下文]

完整的文法定义如下:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

一个完整的补丁可以组合多个操作:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

重要提醒:
- 你必须包含一个带有预期动作(Add/Delete/Update)的头部
- 即使创建新文件,你也必须给新行加 `+` 前缀
- 文件引用只能是相对的,绝不绝对。
