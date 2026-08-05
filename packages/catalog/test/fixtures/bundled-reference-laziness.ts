import { ollamaCloudModelManagerOptions } from "../../src/provider-models/ollama";
import { nanoGptModelManagerOptions } from "../../src/provider-models/openai-compat";

Bun.gc(true);
const rssBefore = process.memoryUsage().rss;
nanoGptModelManagerOptions();
ollamaCloudModelManagerOptions();
Bun.gc(true);
const retainedRssBytes = process.memoryUsage().rss - rssBefore;

console.log(JSON.stringify({ retainedRssBytes }));
