# @oh-my-pi/hashline

一种紧凑的、以行为锚点的补丁语言与应用器。

Hashline 是一种为 LLM 驱动的文件编辑设计的差异格式。它把每个 hunk 绑定到文件内容哈希,这样过期锚点会在损坏代码之前被拒绝;它还对文件系统做了抽象,让同一个打补丁器既能在磁盘、内存、网络上工作,也能针对任何自定义后端工作。

## 快速开始

```ts
import {
	Filesystem,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patcher,
	Patch,
} from "@oh-my-pi/hashline";

const fs = new InMemoryFilesystem();
const snapshots = new InMemorySnapshotStore();
const before = `const greeting = "hi";\nexport { greeting };\n`;
await fs.writeText("hello.ts", before);

const tag = snapshots.record("hello.ts", before);
const patcher = new Patcher({ fs, snapshots });
const patch = Patch.parse(String.raw`[hello.ts#${tag}]
PUT 1.=1:
+const greeting = "hello";`);
const result = await patcher.apply(patch);

console.log(result.sections[0].op); // "update"
console.log(await fs.readText("hello.ts"));
```

## 格式

面向用户的描述见 [`src/prompt.md`](./src/prompt.md),正式文法见 [`src/grammar.lark`](./src/grammar.lark)。

每个文件段以 `[PATH#TAG]` 开头。TAG 是 `SnapshotStore` 记录的、规范化后完整文件文本的 4 位十六进制内容哈希,离开该存储没有意义。打补丁器通过解析 TAG、验证实时文件仍与记录的内容哈希一致,并在不匹配时拒绝或尝试会话感知的恢复,来防止过期锚点。

段内:
- `PUT A.=B:` — 用随后的 `+TEXT` 正文行替换第 A 到 B 行(含端点)。
- `PUT A*:` — 替换从第 A 行开始的语法块。
- `PUT <A:` / `PUT >A:` — 在第 A 行之前/之后插入随后的正文行(`<1` = 头部,`>$` = 尾部)。
- `PUT >A*:` — 在解析出的块的最后一行之后插入随后的正文行。
- `PUT <A` / `PUT >A` / `PUT A.=B @name` / `PUT A* @name` — 在间隙粘贴捕获的寄存器、覆盖一段区间,或覆盖一个解析出的块(无 `:` 头或正文行;`@name` 仅在间隙处可选)。
- `CUT A.=B` / `CUT A*` — 删除具体行或解析出的块并捕获它们(匿名,或给出时用 `@name`)。
- `REM` — 删除段头命名的整个文件。
- `MV DEST` — 把段文件移动/重命名为 `DEST`(可在行编辑之后)。
- `+TEXT` — 字面正文行(单独一个 `+` 表示空行)。

## 抽象

### `Filesystem`

按路径读写文本。默认实现:

- `InMemoryFilesystem` — 由 `Map` 支撑。测试、沙箱。
- `NodeFilesystem` — 通过 `Bun.file`/`Bun.write` 落盘。CLI 的默认选择。

继承 `Filesystem` 可把 hashline 接入任何存储:VFS、S3、LSP 文本文档协议、Git 树,什么都行。

### `SnapshotStore`

必需。Hashline 标签是按路径记录的完整文件内容哈希,因此 `Patcher` 必须拿到观察到它们的那个 store。当实时文件发生分歧时,恢复会针对缓存的编辑前快照重放编辑,并把三方合并应用到当前内容上。

### `Patcher`

编排类。读取、规范化行尾与 BOM、应用编辑、恢复行尾,并通过配置的 `Filesystem` 写入。多段补丁会先整体预检,因此部分批次永远不会落地。
