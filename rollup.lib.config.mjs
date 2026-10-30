import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

/** Unminified bundle of the plugin internals for tests and scripts. */
export default {
	input: "src/lib.ts",
	output: { file: ".build/lib.mjs", format: "es" },
	external: [/^node:/, /^@elgato\//],
	plugins: [typescript({ outDir: ".build", noEmitOnError: false }), nodeResolve({ preferBuiltins: true })],
};
