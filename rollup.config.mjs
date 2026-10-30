import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.gabrielvaz.coding-agents.sdPlugin";

/**
 * The hook client (`src/hook/*.mjs`) is plain JavaScript that the agents run on every event. It is
 * copied as-is next to the bundle; the plugin installs it into ~/.coding-agents-deck at startup.
 */
const copyHook = {
	name: "copy-hook",
	buildStart() {
		this.addWatchFile("src/hook/hook.mjs");
		this.addWatchFile(`${sdPlugin}/manifest.json`);
	},
	writeBundle() {
		mkdirSync(`${sdPlugin}/bin`, { recursive: true });
		copyFileSync("src/hook/hook.mjs", `${sdPlugin}/bin/hook.mjs`);
	},
};

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		},
	},
	plugins: [
		copyHook,
		typescript({
			mapRoot: isWatching ? "./" : undefined,
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true,
		}),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			},
		},
	],
};

export default config;
