<vibe-turn session="{{id}}" cli="{{cli}}" turn="{{turn}}" status="{{status}}" duration="{{duration}}"{{#if model}} model="{{model}}"{{/if}}>
<activity tool-calls="{{toolCount}}" requests="{{requests}}">
{{#each trace}}
- {{this}}
{{/each}}
{{#if traceOverflow}}
- … 另有 {{traceOverflow}} 次较早的工具调用未显示
{{/if}}
</activity>
<response{{#if responseTruncated}} truncated="true" full-output="agent://{{id}}"{{/if}}>
{{response}}
</response>
{{#if error}}
<error>{{error}}</error>
{{/if}}
{{#if alive}}
会话 `{{id}}` 空闲并保留此对话——用 vibe_send 继续它。转录:history://{{id}}
{{/if}}
</vibe-turn>
