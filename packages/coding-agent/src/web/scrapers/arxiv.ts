import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";
import { convertWithMarkit, fetchBinary } from "./utils";

/**
 * Handle arXiv URLs via arXiv API
 */
export const handleArxiv: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "arxiv.org") return null;

		// Extract paper ID from various URL formats
		// /abs/1234.56789, /pdf/1234.56789, /abs/cs/0123456
		const match = parsed.pathname.match(/\/(abs|pdf)\/(.+?)(?:\.pdf)?$/);
		if (!match) return null;

		const paperId = match[2];
		const fetchedAt = new Date().toISOString();
		const notes: string[] = [];

		// Fetch metadata via arXiv API
		const apiUrl = `https://export.arxiv.org/api/query?id_list=${paperId}`;
		const result = await loadPage(apiUrl, { timeout, signal });

		if (!result.ok) return null;

		// Parse the Atom feed response
		const { parseHTML } = await import("linkedom");
		const doc = parseHTML(result.content).document;
		const entry = doc.querySelector("entry");

		if (!entry) return null;

		const title = entry.querySelector("title")?.textContent?.trim()?.replace(/\s+/g, " ");
		const summary = entry.querySelector("summary")?.textContent?.trim();
		const authors = Array.from(entry.querySelectorAll("author name") as Iterable<{ textContent: string | null }>)
			.map(n => n.textContent?.trim())
			.filter((name): name is string => Boolean(name));
		const published = entry.querySelector("published")?.textContent?.trim()?.split("T")[0];
		const categories = Array.from(
			entry.querySelectorAll("category") as Iterable<{ getAttribute: (name: string) => string | null }>,
		)
			.map(c => c.getAttribute("term"))
			.filter((term): term is string => Boolean(term));
		const pdfLink = entry.querySelector('link[title="pdf"]')?.getAttribute("href");

		let md = `# ${title || "arXiv 论文"}\n\n`;
		if (authors.length) md += `**Authors:** ${authors.join(", ")}\n`;
		if (published) md += `**Published:** ${published}\n`;
		if (categories.length) md += `**Categories:** ${categories.join(", ")}\n`;
		md += `**arXiv:** ${paperId}\n\n`;
		md += `---\n\n## Abstract\n\n${summary || "无摘要可用。"}\n\n`;

		// If it was a PDF link or we want full content, try to fetch and convert PDF
		if (match[1] === "pdf" || parsed.pathname.includes(".pdf")) {
			if (pdfLink) {
				notes.push("正在获取 PDF 全文……");
				const pdfResult = await fetchBinary(pdfLink, timeout, signal);
				if (pdfResult.ok) {
					const converted = await convertWithMarkit(pdfResult.buffer, ".pdf", timeout, signal);
					if (converted.ok && converted.content.length > 500) {
						md += `---\n\n## Full Paper\n\n${converted.content}\n`;
						notes.push("已通过 markit 转换 PDF");
					}
				}
			}
		}

		return buildResult(md, {
			url,
			method: "arxiv",
			fetchedAt,
			notes: notes.length ? notes : ["通过 arXiv API 获取"],
		});
	} catch {}

	return null;
};
