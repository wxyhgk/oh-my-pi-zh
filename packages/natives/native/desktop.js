import { loadNative } from "./loader-state.js";

/**
 * Construct a desktop session without loading the native addon until the
 * computer worker receives its initialization message.
 */
export function createDesktopSession(options) {
	const { DesktopSession } = loadNative();
	return new DesktopSession(options);
}
