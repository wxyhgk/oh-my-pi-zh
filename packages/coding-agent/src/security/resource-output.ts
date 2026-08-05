import { sanitizeText } from "@wxyhgk/pi-utils";
import type { InternalResource } from "../internal-urls";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "../session/streaming-output";

export interface SecurityResourceOptions {
	url: string;
	content: string;
	contentType: InternalResource["contentType"];
	isDirectory?: boolean;
}

function boundedJson(content: string): { content: string; truncated: boolean } {
	const sanitized = sanitizeText(content);
	const truncated = truncateHead(sanitized, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return { content: sanitized, truncated: false };
	return {
		content: `${JSON.stringify(
			{
				truncated: true,
				originalBytes: truncated.totalBytes,
				originalLines: truncated.totalLines,
				preview: truncated.content,
			},
			null,
			2,
		)}\n`,
		truncated: true,
	};
}

export function createSecurityResource(options: SecurityResourceOptions): InternalResource {
	const bounded =
		options.contentType === "application/json"
			? boundedJson(options.content)
			: (() => {
					const sanitized = sanitizeText(options.content);
					const truncated = truncateHead(sanitized, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
					return { content: truncated.content, truncated: truncated.truncated };
				})();
	return {
		url: options.url,
		content: bounded.content,
		contentType: options.contentType,
		size: Buffer.byteLength(bounded.content),
		isDirectory: options.isDirectory,
		notes: bounded.truncated ? [`安全资源已截断至 ${DEFAULT_MAX_LINES} 行 / ${DEFAULT_MAX_BYTES} 字节。`] : undefined,
	};
}
