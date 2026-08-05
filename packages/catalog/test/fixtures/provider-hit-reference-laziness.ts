import { getBundledModels } from "../../src/models";
import { createBundledReferenceMap, createReferenceResolver } from "../../src/provider-models/bundled-references";

const providerModels = getBundledModels("fireworks");
const firstId = providerModels[0]?.id;
if (!firstId) throw new Error("fireworks must have bundled models");

Bun.gc(true);
const rssBefore = process.memoryUsage().rss;
const resolveReference = createReferenceResolver(() => createBundledReferenceMap<"openai-completions">("fireworks"));
const resolved = resolveReference(firstId);
Bun.gc(true);
const retainedRssBytes = process.memoryUsage().rss - rssBefore;

console.log(JSON.stringify({ resolvedId: resolved?.id ?? null, retainedRssBytes }));
