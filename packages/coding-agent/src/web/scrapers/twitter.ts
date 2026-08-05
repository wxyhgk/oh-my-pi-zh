import type { HTMLElement } from "linkedom";
import { ToolAbortError } from "../../tools/tool-errors";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";

const NITTER_INSTANCES = [
	"nitter.privacyredirect.com",
	"nitter.tiekoetter.com",
	"nitter.poast.org",
	"nitter.woodland.cafe",
];

/**
 * Handle Twitter/X URLs via Nitter
 */
export const handleTwitter: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!["twitter.com", "x.com", "www.twitter.com", "www.x.com"].includes(parsed.hostname)) {
			return null;
		}

		const fetchedAt = new Date().toISOString();

		// Try Nitter instances
		for (const instance of NITTER_INSTANCES) {
			const nitterUrl = `https://${instance}${parsed.pathname}`;
			const result = await loadPage(nitterUrl, { timeout: Math.min(timeout, 10), signal });

			if (result.ok && result.content.length > 500) {
				// Parse the Nitter HTML
				const { parseHTML } = await import("linkedom");
				const doc = parseHTML(result.content).document;

				// Extract tweet content
				const tweetContent = doc.querySelector(".tweet-content")?.textContent?.trim();
				const fullname = doc.querySelector(".fullname")?.textContent?.trim();
				const username = doc.querySelector(".username")?.textContent?.trim();
				const date = doc.querySelector(".tweet-date a")?.textContent?.trim();
				const stats = doc.querySelector(".tweet-stats")?.textContent?.trim();

				if (tweetContent) {
					let md = `# Tweet by ${fullname || "未知"} (${username || "@?"})\n\n`;
					if (date) md += `*${date}*\n\n`;
					md += `${tweetContent}\n\n`;
					if (stats) md += `---\n${stats.replace(/\s+/g, " ")}\n`;

					// Check for replies/thread
					const replies = Array.from(doc.querySelectorAll(".timeline-item .tweet-content")) as HTMLElement[];
					if (replies.length > 1) {
						md += `\n---\n\n## Thread/Replies\n\n`;
						for (const reply of replies.slice(1, 10)) {
							const replyUser = reply.parentElement?.querySelector(".username")?.textContent?.trim();
							md += `**${replyUser || "@?"}**: ${reply.textContent?.trim()}\n\n`;
						}
					}

					return buildResult(md, {
						url,
						finalUrl: nitterUrl,
						method: "twitter-nitter",
						fetchedAt,
						notes: [`通过 Nitter 获取:${instance}`],
					});
				}
			}
		}
	} catch {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
	}

	if (signal?.aborted) {
		throw new ToolAbortError();
	}

	// X.com blocks all bots - return a helpful error instead of falling through
	return {
		url,
		finalUrl: url,
		contentType: "text/plain",
		method: "twitter-blocked",
		content:
			"Twitter/X 拦截了自动化访问,Nitter 实例均不可用。\n\n尝试:\n- 在浏览器中打开该链接\n- 手动使用其他 Nitter 实例\n- 检查该推文是否可通过存档服务查看",
		fetchedAt: new Date().toISOString(),
		truncated: false,
		notes: ["X.com 拦截机器人访问;Nitter 实例不可用"],
	};
};
