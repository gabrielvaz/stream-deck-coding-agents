import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";

/** The website: 3D hero, live keys and legend, with the plugin's renderer (docs/assets/site.js). */
const shims = {
	name: "node-shims",
	resolveId(id) {
		if (id === "node:events") return path.resolve("src/web/shim-events.ts");
		if (id === "node:path") return path.resolve("src/web/shim-path.ts");
		return null;
	},
};

export default {
	input: "src/web/main.ts",
	output: { file: "docs/assets/site.js", format: "es" },
	plugins: [shims, typescript({ outDir: "docs/assets", noEmitOnError: false, declaration: false }), nodeResolve({ browser: true }), terser()],
};
