/// <reference lib="dom" />
/**
 * Website entry: the 3D hero (Stream Deck + laptop), the state legend and the page's small
 * interactions. Bundled to docs/assets/site.js.
 */
import type { ThemeId } from "../render/tiles";
import "./landing";
import { Scene3D } from "./scene3d";
import { World } from "./world";

function webglAvailable(): boolean {
	try {
		const canvas = document.createElement("canvas");
		return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
	} catch {
		return false;
	}
}

const stage = document.getElementById("stage");
if (stage && webglAvailable()) {
	try {
		const world = new World();
		const scene = new Scene3D(stage, world);
		window.addEventListener("deck-theme", (ev) => {
			scene.theme = (ev as CustomEvent<ThemeId>).detail;
		});
		document.body.classList.add("has-3d");
		(window as unknown as { __deck3d: unknown }).__deck3d = { scene, world };
	} catch (error) {
		console.warn("3D stage unavailable, showing the flat deck", error);
	}
}

// sections fade in as they scroll into view
const reveal = new IntersectionObserver(
	(entries) => {
		for (const e of entries) {
			if (e.isIntersecting) {
				e.target.classList.add("in");
				reveal.unobserve(e.target);
			}
		}
	},
	{ threshold: 0.12 },
);
for (const el of document.querySelectorAll(".reveal")) reveal.observe(el);

// cards follow the cursor with a soft light
for (const card of document.querySelectorAll<HTMLElement>(".card, .step")) {
	card.addEventListener("pointermove", (ev) => {
		const r = card.getBoundingClientRect();
		card.style.setProperty("--mx", `${ev.clientX - r.left}px`);
		card.style.setProperty("--my", `${ev.clientY - r.top}px`);
	});
}
