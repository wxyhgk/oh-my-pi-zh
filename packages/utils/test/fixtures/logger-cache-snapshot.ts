import * as fs from "node:fs";
import * as nodeModule from "node:module";

interface ModuleConstructorWithCache {
	readonly _cache: Record<string, object>;
}

export interface CacheFamily {
	readonly modules: number;
	readonly bytes: number;
	readonly paths: string[];
}

export interface LoggerCacheSnapshot {
	readonly winston: CacheFamily;
	readonly fileStreamRotator: CacheFamily;
	readonly moment: CacheFamily;
}

const moduleCache = (nodeModule.Module as unknown as ModuleConstructorWithCache)._cache;

function snapshotFamily(segment: string): CacheFamily {
	const paths = Object.keys(moduleCache)
		.filter(modulePath => modulePath.replaceAll("\\", "/").includes(segment))
		.sort();
	return {
		modules: paths.length,
		bytes: paths.reduce((total, modulePath) => total + fs.statSync(modulePath).size, 0),
		paths,
	};
}

export function snapshotLoggerRuntime(): LoggerCacheSnapshot {
	return {
		winston: snapshotFamily("/node_modules/winston/"),
		fileStreamRotator: snapshotFamily("/node_modules/file-stream-rotator/"),
		moment: snapshotFamily("/node_modules/moment/"),
	};
}
