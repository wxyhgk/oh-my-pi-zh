import { statSync } from "node:fs";
import "@xterm/headless";

const paths = Object.keys(require.cache)
	.filter(modulePath => modulePath.replaceAll("\\", "/").includes("/node_modules/@xterm/headless/"))
	.sort();
const bytes = paths.reduce((total, modulePath) => total + statSync(modulePath).size, 0);
const memory = process.memoryUsage();
process.stdout.write(
	JSON.stringify({ modules: paths.length, bytes, rss: memory.rss, heapUsed: memory.heapUsed, paths }),
);
