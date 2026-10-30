/**
 * Finds a Playwright install without making it a dependency of the plugin.
 * Set PLAYWRIGHT_DIR to a folder whose node_modules contains `playwright` (or `playwright-core`).
 */
import { createRequire } from "node:module";
import { join } from "node:path";

export async function loadChromium() {
	const candidates = [process.env.PLAYWRIGHT_DIR, process.cwd(), "/tmp/pw"].filter(Boolean);
	for (const dir of candidates) {
		const require = createRequire(join(dir, "package.json"));
		for (const name of ["playwright", "playwright-core"]) {
			try {
				return require(name).chromium;
			} catch {
				// try next
			}
		}
	}
	throw new Error("Playwright not found: npm i -D playwright, or set PLAYWRIGHT_DIR");
}
