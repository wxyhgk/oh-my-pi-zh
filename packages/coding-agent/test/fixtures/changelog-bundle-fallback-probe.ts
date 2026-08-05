import { VERSION } from "@oh-my-pi/pi-utils";
import { parseChangelog } from "../../src/utils/changelog";

const missingPackageChangelogPath = process.argv[2];
if (!missingPackageChangelogPath) {
	throw new Error("Expected a missing package changelog path argument");
}

const entries = await parseChangelog(missingPackageChangelogPath);
const latest = entries[0];
const version = latest ? `${latest.major}.${latest.minor}.${latest.patch}` : undefined;
if (version !== VERSION || !latest?.content.startsWith(`## [${VERSION}]`)) {
	throw new Error(`Unexpected latest changelog release: ${JSON.stringify({ version, expected: VERSION })}`);
}

process.stdout.write(JSON.stringify({ version, entries: entries.length }));
