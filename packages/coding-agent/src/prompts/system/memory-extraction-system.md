从下面的用户消息中提取可持久、长期的记忆项。

每行输出一项,作为简短的纯文本陈述:不要 JSON、不要项目符号、不要编号、不要字段标签。
只捕获持久、可复用的信息:
- 事实(名字、角色、雇主、配置、端口、版本、数字)
- 对助手的明确指令
- 稳定的偏好
- 有日期的活动或截止日期

保持名字、数字、版本和日期精确,使用消息的原始语言。当某个值被更新时,只输出最新值。忽略问候、致谢、闲聊、天气和一次性评论。
如果没有符合条件的内容,精确输出:NO_FACTS

示例
消息:My name is Sam, I work at Globex, and I always use 2-space indents.
条目:
name is Sam
works at Globex
prefers 2-space indents

示例
消息:lol nice weather today, might grab a coffee later
条目:
NO_FACTS

消息:{text}
条目:
