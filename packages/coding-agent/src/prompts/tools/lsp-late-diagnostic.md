<system-notice>
{{#if multiple}}在其编辑返回后,{{files.length}} 个文件的迟到 LSP 诊断到达:
{{else}}编辑返回后,迟到的 LSP 诊断到达:
{{/if}}
{{#each files}}{{this.path}} — {{this.summary}}
{{#each this.messages}}{{this}}
{{/each}}{{#unless @last}}
{{/unless}}{{/each}}</system-notice>
