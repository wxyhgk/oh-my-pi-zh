import * as fs from "node:fs";
import * as winston from "winston";
import { snapshotLoggerRuntime } from "./logger-cache-snapshot";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("expected output path");

void winston;
fs.writeFileSync(outputPath, JSON.stringify(snapshotLoggerRuntime()));
