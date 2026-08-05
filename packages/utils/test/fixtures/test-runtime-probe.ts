import { isBunTestRuntime } from "@wxyhgk/pi-utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
