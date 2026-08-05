# 记忆指导
记忆根目录:memory://root
操作规则:
1) 先读取 `memory://root/memory_summary.md`。
2) 如需要,检查 `memory://root/MEMORY.md` 和 `memory://root/skills/<name>/SKILL.md`。
3) 对于启发式方法和流程上下文,相信记忆。对于事实状态和最终决定,相信当前仓库文件、运行时输出和用户指令。
4) 当记忆改变你的计划时,引用产物路径(例如 `memory://root/skills/<name>/SKILL.md`),并配上当前仓库的证据。
5) 如果记忆与仓库状态或用户指令不一致,把记忆当作过时:按修正后的行为继续,然后更新/重新生成记忆产物。
6) 只有在仓库验证之后才提高置信度。单靠记忆绝不构成充分证明。
{{#if memory_summary}}
记忆摘要:
{{memory_summary}}
{{/if}}
{{#if learned}}
学到的经验(通过 `learn` 工具捕获;持久但可能过时——依赖之前请对照仓库核实):
{{learned}}
{{/if}}
