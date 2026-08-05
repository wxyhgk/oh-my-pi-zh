import "@wxyhgk/pi-utils/env";
import { APP_NAME, CONFIG_DIR_NAME } from "@wxyhgk/pi-utils/dirs";
import chalk from "chalk";

export function getExtraHelpText(): string {
	return `${chalk.bold("环境变量:")}
  ${chalk.dim("# 核心提供商")}
  ANTHROPIC_API_KEY          - Anthropic Claude 模型
  ANTHROPIC_OAUTH_TOKEN      - Anthropic OAuth(优先于 API 密钥)
  CLAUDE_CODE_USE_FOUNDRY    - 启用 Anthropic Foundry 模式(使用 Foundry 端点 + mTLS)
  FOUNDRY_BASE_URL           - Anthropic Foundry 基础 URL(例如 https://<foundry-host>)
  ANTHROPIC_FOUNDRY_API_KEY  - Foundry 模式中用作 Authorization: Bearer <token> 的 Anthropic token
  ANTHROPIC_CUSTOM_HEADERS   - 用于 Foundry 或任意自定义 ANTHROPIC_BASE_URL 网关的附加请求头(例如 "user-id: USERNAME")
  CLAUDE_CODE_CLIENT_CERT    - 用于 mTLS 的客户端证书(PEM 路径或内联 PEM)
  CLAUDE_CODE_CLIENT_KEY     - 用于 mTLS 的客户端私钥(PEM 路径或内联 PEM)
  NODE_EXTRA_CA_CERTS        - 用于服务器证书校验的 CA 证书包路径(或内联 PEM)
  OPENAI_API_KEY             - OpenAI GPT 模型
  GEMINI_API_KEY             - Google Gemini 模型
  COPILOT_GITHUB_TOKEN      - GitHub Copilot

  ${chalk.dim("# 其他 LLM 提供商")}
  AZURE_OPENAI_API_KEY       - Azure OpenAI 模型
  GROQ_API_KEY               - Groq 模型
  CEREBRAS_API_KEY           - Cerebras 模型
  XAI_API_KEY                - xAI Grok 模型
  OPENROUTER_API_KEY         - OpenRouter 聚合模型
  KILO_API_KEY               - Kilo Gateway 模型
  MISTRAL_API_KEY            - Mistral 模型
  ZAI_API_KEY                - z.ai 模型(ZhipuAI/GLM)
  UMANS_AI_CODING_PLAN_API_KEY - Umans AI Coding Plan 模型
  UMANS_WEBSEARCH_PROVIDER    - Umans 网关的网络搜索后端(native 或 exa)
  MINIMAX_API_KEY            - MiniMax 模型
  OPENCODE_API_KEY           - OpenCode Zen/OpenCode Go 模型
  CURSOR_ACCESS_TOKEN        - Cursor AI 模型
  AI_GATEWAY_API_KEY         - Vercel AI Gateway
  WAFER_SERVERLESS_API_KEY   - Wafer Serverless(按量付费)

  ${chalk.dim("# 云提供商")}
  AWS_PROFILE                - AWS Bedrock(或 AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
  GOOGLE_CLOUD_PROJECT       - Google Vertex AI(需要 GOOGLE_CLOUD_LOCATION)
  GOOGLE_APPLICATION_CREDENTIALS - Vertex AI 的服务账户

  ${chalk.dim("# 搜索与工具")}
  EXA_API_KEY                - Exa 网络搜索
  BRAVE_API_KEY              - Brave 网络搜索
  PERPLEXITY_API_KEY         - Perplexity 网络搜索 API 密钥(可选;匿名回退)
  PERPLEXITY_COOKIES         - Perplexity 网络搜索(会话 cookie)
  TAVILY_API_KEY             - Tavily 网络搜索
  TINYFISH_API_KEY           - TinyFish 网络搜索
  FIRECRAWL_API_KEY          - Firecrawl 网络搜索
  ANTHROPIC_SEARCH_API_KEY   - Anthropic 网络搜索(覆盖;与主 ANTHROPIC_API_KEY 隔离)
  ANTHROPIC_SEARCH_BASE_URL  - Anthropic 网络搜索基础 URL(覆盖;与 ANTHROPIC_SEARCH_API_KEY 配套)

  ${chalk.dim("# 配置")}
  OMP_PROFILE                 - 命名配置档,用于隔离的 Agent 状态(与 --profile 相同)
  使用 \`omp-zh --profile <name> --alias <command>\` 为配置档创建 shell 快捷方式
  PI_CODING_AGENT_DIR        - 会话存储目录(默认:~/${CONFIG_DIR_NAME}/agent)
  PI_PACKAGE_DIR             - 覆盖包目录(用于 Nix/Guix 存储路径)
  PI_SMOL_MODEL              - 覆盖 smol/快速模型(参见 --smol)
  PI_SLOW_MODEL              - 覆盖 slow/推理模型(参见 --slow)
  PI_PLAN_MODEL              - 覆盖规划模型(参见 --plan)
  PI_NO_PTY                  - 禁用基于 PTY 的交互式 bash 执行
  完整的环境变量参考请参见:
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold("可用工具(除非另有说明,默认启用):")}
  read          - 读取文件内容
  bash          - 执行 bash 命令
  edit          - 使用查找/替换编辑文件
  write         - 写入文件(创建/覆盖)
  grep          - 搜索文件内容
  glob          - 按 glob 模式查找文件
  lsp           - 语言服务器协议(代码智能)
  python        - 执行 Python 代码(需要:${APP_NAME} setup python)
  notebook      - 编辑 Jupyter 笔记本
  inspect_image - 使用视觉模型分析图片
  browser       - 浏览器自动化(Puppeteer)
  computer      - 宿主机桌面捕获与输入(默认禁用)
  task          - 启动子 Agent 执行并行任务
  todo          - 管理 todo/任务列表
  web_search    - 搜索网络
  ask           - 向用户提问(仅交互模式)

${chalk.bold("插件选项:")}
  --plugin-dir <path>        从目录加载插件(可重复)

${chalk.bold("常用命令:")}
  omp agents unpack           - 将内置子 Agent 导出到 ~/.omp/agent/agents(默认)
  omp agents unpack --project - 将内置子 Agent 导出到 ./.omp/agents`;
}
