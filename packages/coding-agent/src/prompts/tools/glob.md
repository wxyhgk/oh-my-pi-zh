用快速模式匹配对文件、目录和路径型内部 URL 做 glob。

<instruction>
- `path`:glob、文件、目录或路径型内部 URL;多个目标用 `;` 分隔(`src/**/*.ts; test/**/*.ts`)。
- 支持 `memory://` glob 模式。`ssh://` 没有本地路径;用 `read`。其他内部 URL 只接受精确路径。
- `gitignore` 默认为 `true`。对 `.env*`、日志或构建输出等被忽略的文件设置为 `false`。
- `hidden` 默认为 `true`;对被忽略的点文件,配合 `gitignore: false` 使用。
</instruction>

<output>
匹配结果最新优先,按目录分组;目录以 `/` 结尾。
</output>

<avoid>
开放式多轮发现 → {{#if scoutAvailable}}Task + scout。{{else}}Task。{{/if}}
</avoid>
