用支持视觉的模型检查图像文件,并返回紧凑的文本分析。

<instruction>
- 用于图像理解任务(OCR、UI/截图调试、场景/物体问题)
- 提供 `path` 作为本地图像文件路径、`Image #N` 附件标签或 `attachment://N` URI
- 写一个具体的 `question`:
  - 检查什么
  - 约束(例如:"quote visible text verbatim"、"only report confirmed findings")
  - 期望的输出格式(要点/表格/JSON/简短回答)
- 让 `question` 扎根于可观察的证据;细节不清楚时要求说明不确定性
- 目标是图像分析时,用此工具而不是 `read`
</instruction>

<output>
- 返回视觉模型的纯文本分析
- 工具输出中不返回图像内容块
</output>

<critical>
- 如果图像提交被设置阻止,工具会以可操作错误失败
- 如果配置的模型不支持图像输入,重试前先配置支持视觉的模型角色
</critical>
