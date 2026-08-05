import type { ClientRequest, IncomingMessage } from "node:http";
import * as https from "node:https";
import * as stream from "node:stream";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import type { FetchImpl } from "../types";
import { connectProxiedSocket } from "../utils/proxy";

type CoworkTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
	rejectUnauthorized?: boolean;
	serverName?: string;
	ciphers?: string;
};

type CoworkRequestInit = RequestInit & {
	proxy?: string;
	tls?: CoworkTlsOptions;
};

type RequestBody = string | Uint8Array;

type AgentLease = {
	agent: https.Agent;
	release?: () => void;
};

const directAgent = new https.Agent({ keepAlive: true });
const fallbackFetch: FetchImpl = globalThis.fetch;

function isHeaderRecord(headers: RequestInit["headers"]): headers is Record<string, string> {
	return headers !== undefined && !(headers instanceof Headers) && !Array.isArray(headers);
}

function resolveBody(body: RequestInit["body"]): RequestBody | undefined {
	if (typeof body === "string" || body instanceof Uint8Array) return body;
	return undefined;
}

function buildOrderedHeaders(
	url: URL,
	source: Record<string, string>,
	body: RequestBody | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {};
	let hasHost = false;
	let hasContentLength = false;
	for (const name in source) {
		const lowerName = name.toLowerCase();
		if (lowerName === "host") hasHost = true;
		if (lowerName === "content-length") hasContentLength = true;
		if (lowerName === "accept-encoding" && !hasHost) {
			headers.Host = url.host;
			hasHost = true;
		}
		headers[name] = source[name];
	}
	if (!hasHost) headers.Host = url.host;
	const length = typeof body === "string" ? Buffer.byteLength(body) : body?.byteLength;
	if (!hasContentLength && length !== undefined) headers["Content-Length"] = String(length);
	return headers;
}

function resolveTlsOptions(url: URL, options: CoworkTlsOptions | undefined): tls.ConnectionOptions {
	const resolved: tls.ConnectionOptions = {
		ALPNProtocols: ["http/1.1"],
		ciphers: options?.ciphers ?? tls.DEFAULT_CIPHERS,
		rejectUnauthorized: options?.rejectUnauthorized ?? true,
		servername: options?.serverName ?? url.hostname,
	};
	if (options?.ca !== undefined) resolved.ca = options.ca;
	if (options?.cert !== undefined) resolved.cert = options.cert;
	if (options?.key !== undefined) resolved.key = options.key;
	return resolved;
}

async function acquireAgent(
	url: URL,
	proxy: string | undefined,
	tlsOptions: tls.ConnectionOptions,
	signal: AbortSignal | undefined,
): Promise<AgentLease> {
	if (!proxy) return { agent: directAgent };
	const socket = await connectProxiedSocket(proxy, url.origin, { signal, tls: tlsOptions });
	const agent = new https.Agent({ keepAlive: false });
	agent.createConnection = () => socket;
	return { agent, release: () => agent.destroy() };
}

function responseHeaders(message: IncomingMessage): Headers {
	const headers = new Headers();
	for (let index = 0; index < message.rawHeaders.length; index += 2) {
		headers.append(message.rawHeaders[index], message.rawHeaders[index + 1]);
	}
	return headers;
}

function decodedResponseStream(message: IncomingMessage): stream.Readable {
	const rawEncoding = message.headers["content-encoding"];
	const encoding = (Array.isArray(rawEncoding) ? rawEncoding[0] : rawEncoding)?.trim().toLowerCase();
	switch (encoding) {
		case "gzip":
			return message.pipe(zlib.createGunzip());
		case "deflate":
			return message.pipe(zlib.createInflate());
		case "br":
			return message.pipe(zlib.createBrotliDecompress());
		case "zstd":
			return message.pipe(zlib.createZstdDecompress());
		default:
			return message;
	}
}

function createResponse(message: IncomingMessage, method: string): Response {
	const status = message.statusCode;
	if (status === undefined) throw new Error("Cowork transport received a response without an HTTP status.");
	const hasBody = method !== "HEAD" && status !== 204 && status !== 304;
	const body = hasBody ? stream.Readable.toWeb(decodedResponseStream(message)) : null;
	return new Response(body, {
		status,
		statusText: message.statusMessage,
		headers: responseHeaders(message),
	});
}

async function sendCoworkRequest(
	url: URL,
	init: CoworkRequestInit,
	sourceHeaders: Record<string, string>,
	body: RequestBody | undefined,
): Promise<Response> {
	const method = init.method ?? "GET";
	const signal = init.signal ?? undefined;
	const tlsOptions = resolveTlsOptions(url, init.tls);
	const lease = await acquireAgent(url, init.proxy, tlsOptions, signal);
	const headers = buildOrderedHeaders(url, sourceHeaders, body);
	const result = Promise.withResolvers<Response>();
	let request: ClientRequest | undefined;
	const release = (): void => {
		signal?.removeEventListener("abort", abort);
		lease.release?.();
	};
	const abort = (): void => {
		const reason = signal?.reason;
		request?.destroy(reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError"));
	};
	if (signal?.aborted) {
		release();
		signal.throwIfAborted();
	}
	signal?.addEventListener("abort", abort, { once: true });
	request = https.request(
		{
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port || 443,
			path: `${url.pathname}${url.search}`,
			method,
			headers,
			agent: lease.agent,
			...tlsOptions,
		},
		message => {
			message.once("close", release);
			try {
				result.resolve(createResponse(message, method));
			} catch (error) {
				message.destroy();
				release();
				result.reject(error);
			}
		},
	);
	request.once("error", error => {
		release();
		result.reject(error);
	});
	request.end(body);
	return result.promise;
}

/** Sends Cowork-profiled HTTPS requests with stable header order, HTTP/1.1, and streaming decompression. */
export const coworkFetch: FetchImpl = async (input, init) => {
	if (input instanceof Request || init === undefined || !isHeaderRecord(init.headers)) {
		return fallbackFetch(input, init);
	}
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return fallbackFetch(input, init);
	}
	if (url.protocol !== "https:") return fallbackFetch(input, init);
	const body = resolveBody(init.body);
	if (init.body != null && body === undefined) return fallbackFetch(input, init);
	const coworkInit: CoworkRequestInit = init;
	return sendCoworkRequest(url, coworkInit, init.headers, body);
};
