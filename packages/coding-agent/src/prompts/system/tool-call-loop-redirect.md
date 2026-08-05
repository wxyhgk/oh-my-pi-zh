<system-interrupt reason="tool_call_loop_detected">
你用相同参数连续调用了 `{{tool_name}}` {{count}} 次:
`{{arguments_summary}}`

上次结果(截断):`{{result_summary}}`

本轮绝不再用这些参数调用 `{{tool_name}}`。换不同的参数,选择另一个工具,或总结发现并在完成时 yield。
</system-interrupt>
