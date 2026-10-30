import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";

/** The landing page's live deck: the plugin's renderer for the browser (docs/assets/deck.js). */
const shims = {
	name: "node-shims",
	resolveId(id) {
		if (id === "node:events") return path.resolve("src/web/shim-events.ts");
		if (id === "node:path") return path.resolve("src/web/shim-path.ts");
		return null;
	},
};

export default {
	input: "src/web/landing.ts",
	output: { file: "docs/assets/deck.js", format: "es" },
	plugins: [shims, typescript({ outDir: "docs/assets", noEmitOnError: false, declaration: false }), nodeResolve({ browser: true }), terser()],
};
