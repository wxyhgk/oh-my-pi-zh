declare module "winston-daily-rotate-file/daily-rotate-file.js" {
	import type DailyRotateFile from "winston-daily-rotate-file";

	const DailyRotateFileImplementation: typeof DailyRotateFile;
	export default DailyRotateFileImplementation;
}
