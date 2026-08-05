[重要:用户已调用 “{{name}}” 技能,表示他们希望你遵循其指令。完整技能内容已在下方加载。]

{{body}}

---

[技能目录:{{baseDir}}]
使用该目录的绝对路径解析此技能中的任何相对路径(例如 `scripts/foo.js`、`templates/config.yaml`):读取引用的资源与模板,并在技能指令要求时用终端工具运行脚本。
{{#if userArgs}}
用户:{{userArgs}}
{{/if}}
