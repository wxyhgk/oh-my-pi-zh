<system-notice>
{{#if multiple}}{{jobs.length}} 个后台作业已完成。使用下面的结果恢复你的工作。

{{else}}后台作业 {{jobs.[0].jobId}} 已完成。使用下面的结果恢复你的工作。
{{/if}}{{#each jobs}}{{#if @root.multiple}}── 作业 {{this.jobId}}{{#if this.label}} ({{this.label}}){{/if}} ──
{{/if}}{{this.result}}{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>
