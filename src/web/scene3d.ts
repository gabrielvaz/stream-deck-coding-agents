/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The website's hero: a Stream Deck and a laptop on a desk, in real-time 3D.
 *
 * The 15 key faces are drawn by the plugin's own renderer; you can drag to look around, click a
 * key to bring its session to the laptop screen, and hold a key that waits for approval until the
 * green bar fills. Allow / Deny / Overview keys work like in the plugin.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { AGENTS, WAITING } from "../core/agents";
import type { Session } from "../core/store";
import { decisionTile, hubTile, pageTile, sessionTile, type ThemeId, toDataUrl } from "../render/tiles";
import { MacScreen } from "./mac-screen";
import type { World } from "./world";

type KeyKind = "session" | "hub" | "allow" | "deny" | "page";

type Key = {
	index: number;
	kind: KeyKind;
	cap: THREE.Mesh;
	face: THREE.Mesh;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	texture: THREE.CanvasTexture;
	baseZ: number;
	press: number;
	flash: number;
	flashColor: THREE.Color;
	lastSvg: string;
	loading: number;
	down: { at: number; uid: string | null; held: boolean } | null;
	session: Session | null;
};

const HOLD_MS = 600;
const KEY = 0.148;
const PITCH = 0.188;
const BODY = { w: 1.18, h: 0.84, d: 0.22 };
const FACE_PX = 256;

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

/** Keyboard texture for the laptop: rows of dark keycaps. */
function keyboardTexture(): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = 1024;
	c.height = 380;
	const ctx = c.getContext("2d") as CanvasRenderingContext2D;
	ctx.fillStyle = "#0e0f12";
	ctx.fillRect(0, 0, c.width, c.height);
	const rows = [14, 14, 13, 12, 11];
	const keyH = 58;
	rows.forEach((n, r) => {
		const gap = 8;
		const w = (c.width - 24 - gap * (n - 1)) / n;
		for (let i = 0; i < n; i += 1) {
			ctx.fillStyle = "#1c1d21";
			roundedRectPath(ctx, 12 + i * (w + gap), 14 + r * (keyH + 12), w, keyH, 8);
			ctx.fill();
		}
	});
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.anisotropy = 4;
	return tex;
}

export class Scene3D {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera: THREE.PerspectiveCamera;
	private controls: OrbitControls;
	private composer: EffectComposer;
	private bloom: UnrealBloomPass;
	private keys: Key[] = [];
	private raycaster = new THREE.Raycaster();
	private pointer = new THREE.Vector2();
	private screen: MacScreen;
	private screenTexture: THREE.CanvasTexture;
	private deckGlow: THREE.PointLight;
	private lastInteraction = 0;
	private lastKeysAt = 0;
	private lastScreenAt = 0;
	private hovered: Key | null = null;
	private running = true;
	private homeAzimuth = 0;
	private intro = { from: new THREE.Vector3(-2.4, 4.6, 7.8), to: new THREE.Vector3(), start: 0 };
	private tip: HTMLDivElement;
	private coach: HTMLDivElement;
	private heldOnce = false;
	private audio: AudioContext | null = null;
	theme: ThemeId = "pulse";

	constructor(
		private readonly host: HTMLElement,
		private readonly world: World,
	) {
		this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.toneMapping = THREE.NeutralToneMapping;
		this.renderer.toneMappingExposure = 1.05;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFShadowMap;
		this.renderer.domElement.className = "stage-canvas";
		host.append(this.renderer.domElement);

		this.scene.background = new THREE.Color(0x0a0b0e);
		this.scene.fog = new THREE.Fog(0x0a0b0e, 9, 19);
		const pmrem = new THREE.PMREMGenerator(this.renderer);
		this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		this.scene.environmentIntensity = 0.55;

		this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
		this.camera.position.set(-0.3, 2.25, 5.5);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.target.set(0.08, 0.86, 0.1);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.06;
		this.controls.enablePan = false;
		this.controls.enableZoom = false;
		this.controls.rotateSpeed = 0.55;
		this.controls.minPolarAngle = 0.55;
		this.controls.maxPolarAngle = 1.38;
		this.controls.update();
		this.homeAzimuth = this.controls.getAzimuthalAngle();
		this.controls.minAzimuthAngle = this.homeAzimuth - 0.85;
		this.controls.maxAzimuthAngle = this.homeAzimuth + 0.85;
		// fly in from above on load
		this.intro.to.copy(this.camera.position);
		this.camera.position.copy(this.intro.from);
		this.intro.start = performance.now();

		this.tip = document.createElement("div");
		this.tip.className = "key-tip";
		this.coach = document.createElement("div");
		this.coach.className = "key-coach";
		this.coach.innerHTML = "<b>Hold me</b><span>to approve</span>";
		host.append(this.tip, this.coach);
		try {
			this.heldOnce = localStorage.getItem("deck-held") === "1";
		} catch {
			this.heldOnce = false;
		}

		this.lights();
		this.desk();
		this.deck();
		this.screen = new MacScreen(world);
		this.screenTexture = new THREE.CanvasTexture(this.screen.canvas);
		this.screenTexture.colorSpace = THREE.SRGBColorSpace;
		this.screenTexture.anisotropy = 8;
		this.laptop();
		this.deckGlow = new THREE.PointLight(0xffb238, 0.6, 2.2, 2);
		this.deckGlow.position.set(-1.1, 0.6, 1.75);
		this.scene.add(this.deckGlow);

		this.composer = new EffectComposer(this.renderer);
		this.composer.addPass(new RenderPass(this.scene, this.camera));
		this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.55, 0.78);
		this.composer.addPass(this.bloom);
		this.composer.addPass(new OutputPass());

		this.bindInput();
		new ResizeObserver(() => this.resize()).observe(host);
		this.resize();
		// stop drawing while the hero is off screen
		new IntersectionObserver((entries) => {
			this.running = entries.some((e) => e.isIntersecting);
			if (this.running) this.loop();
		}).observe(host);
		this.loop();
	}

	// ---------------------------------------------------------------------------------------------- scene

	private lights(): void {
		const key = new THREE.DirectionalLight(0xffffff, 2.2);
		key.position.set(-3, 6, 4);
		key.castShadow = true;
		key.shadow.mapSize.set(2048, 2048);
		key.shadow.camera.left = -4;
		key.shadow.camera.right = 4;
		key.shadow.camera.top = 4;
		key.shadow.camera.bottom = -4;
		key.shadow.radius = 6;
		key.shadow.bias = -0.0004;
		this.scene.add(key);
		const rim = new THREE.DirectionalLight(0x6f9bff, 1.2);
		rim.position.set(4, 3, -5);
		this.scene.add(rim);
		this.scene.add(new THREE.HemisphereLight(0x9fb0ff, 0x0b0b0e, 0.35));
	}

	private desk(): void {
		const desk = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.82, metalness: 0.05 }));
		desk.rotation.x = -Math.PI / 2;
		desk.receiveShadow = true;
		this.scene.add(desk);
		// a soft spot of light under the devices
		const spot = new THREE.SpotLight(0xfff1dc, 18, 12, 0.55, 0.9, 1.6);
		spot.position.set(0, 6, 2);
		spot.target.position.set(0, 0, 0);
		this.scene.add(spot, spot.target);
	}

	private deck(): void {
		const group = new THREE.Group();
		const tilt = new THREE.Group();
		group.add(tilt);

		const plastic = new THREE.MeshPhysicalMaterial({ color: 0x16171a, roughness: 0.58, metalness: 0, clearcoat: 0.2, clearcoatRoughness: 0.55 });
		const body = new THREE.Mesh(new RoundedBoxGeometry(BODY.w, BODY.h, BODY.d, 5, 0.06), plastic);
		body.castShadow = true;
		body.receiveShadow = true;
		tilt.add(body);

		// a faint darker well around the keys
		const well = new THREE.Mesh(new RoundedBoxGeometry(5 * PITCH + 0.03, 3 * PITCH + 0.03, 0.01, 2, 0.03), new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.75 }));
		const keysCenterY = BODY.h / 2 - 0.12 - (3 * PITCH - (PITCH - KEY)) / 2;
		well.position.set(0, keysCenterY, BODY.d / 2 - 0.002);
		tilt.add(well);

		const capMaterial = new THREE.MeshPhysicalMaterial({ color: 0x08090a, roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08 });
		const glassMaterial = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.035, clearcoat: 1, envMapIntensity: 0.9, depthWrite: false });
		const capGeometry = new RoundedBoxGeometry(KEY, KEY, 0.06, 3, 0.022);
		const faceGeometry = new THREE.PlaneGeometry(KEY - 0.018, KEY - 0.018);
		const glassGeometry = new THREE.PlaneGeometry(KEY - 0.008, KEY - 0.008);
		const kinds: KeyKind[] = [...Array(11).fill("session"), "hub", "allow", "deny", "page"];
		for (let i = 0; i < 15; i += 1) {
			const col = i % 5;
			const row = Math.floor(i / 5);
			const cap = new THREE.Mesh(capGeometry, capMaterial);
			cap.castShadow = true;
			const baseZ = BODY.d / 2 - 0.03 + 0.014;
			cap.position.set((col - 2) * PITCH, keysCenterY + (1 - row) * PITCH, baseZ);
			const canvas = document.createElement("canvas");
			canvas.width = FACE_PX;
			canvas.height = FACE_PX;
			const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
			ctx.fillStyle = "#050506";
			ctx.fillRect(0, 0, FACE_PX, FACE_PX);
			const texture = new THREE.CanvasTexture(canvas);
			texture.colorSpace = THREE.SRGBColorSpace;
			texture.anisotropy = 8;
			const faceMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
			faceMaterial.color.setScalar(1.18); // LCDs glow a little above white for the bloom
			const face = new THREE.Mesh(faceGeometry, faceMaterial);
			face.position.z = 0.0306;
			const glass = new THREE.Mesh(glassGeometry, glassMaterial);
			glass.position.z = 0.0312;
			glass.renderOrder = 2;
			cap.add(face, glass);
			tilt.add(cap);
			const key: Key = {
				index: i,
				kind: kinds[i],
				cap,
				face,
				canvas,
				ctx,
				texture,
				baseZ,
				press: 0,
				flash: 0,
				flashColor: new THREE.Color(0x2fd27a),
				lastSvg: "",
				loading: 0,
				down: null,
				session: null,
			};
			cap.userData.key = key;
			face.userData.key = key;
			this.keys.push(key);
		}

		// lean the deck back on its stand, resting on the desk
		const lean = 0.42;
		tilt.rotation.x = -lean;
		tilt.position.y = (BODY.h / 2) * Math.cos(lean) + (BODY.d / 2) * Math.sin(lean) + 0.02;
		tilt.position.z = -0.05;
		const standShape = new THREE.Shape();
		standShape.moveTo(0, 0);
		standShape.lineTo(0.62, 0);
		standShape.lineTo(0.08, 0.52);
		standShape.lineTo(0, 0.52);
		standShape.closePath();
		const stand = new THREE.Mesh(new THREE.ExtrudeGeometry(standShape, { depth: 1.0, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 3 }), plastic);
		stand.rotation.y = Math.PI / 2;
		stand.position.set(-0.5, 0.02, -0.06);
		stand.castShadow = true;
		group.add(stand);

		// a USB-C cable leaving from the back
		const curve = new THREE.CatmullRomCurve3([
			new THREE.Vector3(0.25, 0.3, -0.42),
			new THREE.Vector3(0.3, 0.06, -0.75),
			new THREE.Vector3(0.6, 0.02, -1.4),
			new THREE.Vector3(1.4, 0.02, -2.6),
		]);
		const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.014, 8), new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.5 }));
		cable.castShadow = true;
		group.add(cable);

		group.position.set(-1.12, 0, 1.12);
		group.rotation.y = 0.4;
		group.scale.setScalar(1.35);
		this.scene.add(group);
	}

	private laptop(): void {
		const group = new THREE.Group();
		const alu = new THREE.MeshPhysicalMaterial({ color: 0x3a3c42, metalness: 0.85, roughness: 0.36, clearcoat: 0.25 });
		const W = 3.13;
		const D = 2.21;
		const T = 0.14;
		const base = new THREE.Mesh(new RoundedBoxGeometry(W, T, D, 5, 0.06), alu);
		base.position.y = T / 2;
		base.castShadow = true;
		base.receiveShadow = true;
		group.add(base);
		const keyboard = new THREE.Mesh(new THREE.PlaneGeometry(2.62, 0.98), new THREE.MeshStandardMaterial({ map: keyboardTexture(), roughness: 0.7 }));
		keyboard.rotation.x = -Math.PI / 2;
		keyboard.position.set(0, T + 0.001, -0.38);
		group.add(keyboard);
		const trackpad = new THREE.Mesh(new RoundedBoxGeometry(1.25, 0.004, 0.78, 2, 0.002), new THREE.MeshPhysicalMaterial({ color: 0x45474e, metalness: 0.6, roughness: 0.22, clearcoat: 0.6 }));
		trackpad.position.set(0, T + 0.001, 0.55);
		group.add(trackpad);

		// the lid hinges at the back edge, opened a little past vertical
		const hinge = new THREE.Group();
		hinge.position.set(0, T, -D / 2 + 0.03);
		hinge.rotation.x = -0.24;
		group.add(hinge);
		const LH = 2.14;
		const lid = new THREE.Mesh(new RoundedBoxGeometry(W, LH, 0.04, 5, 0.05), alu);
		lid.position.set(0, LH / 2, -0.02);
		lid.castShadow = true;
		hinge.add(lid);
		const bezel = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.05, LH - 0.05), new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.35, clearcoat: 0.3, envMapIntensity: 0.3 }));
		bezel.position.set(0, LH / 2, 0.0015);
		hinge.add(bezel);
		const sw = 2.94;
		const sh = sw / 1.6;
		const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), new THREE.MeshBasicMaterial({ map: this.screenTexture, toneMapped: false }));
		screen.position.set(0, LH / 2 + 0.035, 0.003);
		hinge.add(screen);
		const glare = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.025, roughness: 0.12, clearcoat: 0.5, envMapIntensity: 0.6, depthWrite: false }));
		glare.position.set(0, LH / 2 + 0.035, 0.004);
		hinge.add(glare);
		const notch = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.07, 0.002, 2, 0.02), new THREE.MeshBasicMaterial({ color: 0x050506 }));
		notch.position.set(0, LH / 2 + 0.035 + sh / 2 - 0.03, 0.0045);
		hinge.add(notch);

		group.position.set(0.95, 0, -0.55);
		group.rotation.y = -0.34;
		this.scene.add(group);
	}

	// ---------------------------------------------------------------------------------------------- input

	private bindInput(): void {
		const el = this.renderer.domElement;
		el.addEventListener("pointermove", (ev) => {
			this.setPointer(ev);
			const key = this.pick();
			if (key !== this.hovered) {
				this.hovered = key;
				el.style.cursor = key ? "pointer" : "grab";
			}
		});
		el.addEventListener("pointerdown", (ev) => {
			this.setPointer(ev);
			this.lastInteraction = performance.now();
			const key = this.pick();
			if (!key) {
				el.style.cursor = "grabbing";
				return;
			}
			// pressing a key must not rotate the scene
			this.controls.enabled = false;
			this.click(0.9);
			el.setPointerCapture(ev.pointerId);
			key.down = { at: performance.now(), uid: key.session?.uid ?? null, held: false };
			const down = key.down;
			setTimeout(() => {
				if (key.down === down) {
					down.held = true;
					this.hold(key, down.uid);
				}
			}, HOLD_MS);
		});
		const release = () => {
			this.controls.enabled = true;
			el.style.cursor = this.hovered ? "pointer" : "grab";
			for (const key of this.keys) {
				if (!key.down) continue;
				const { held, uid } = key.down;
				key.down = null;
				if (!held) this.press(key, uid);
			}
		};
		el.addEventListener("pointerup", release);
		el.addEventListener("pointercancel", release);
		el.addEventListener("pointerleave", () => {
			this.hovered = null;
		});
		this.controls.addEventListener("start", () => (this.lastInteraction = performance.now()));

		// keys 1–9 on the keyboard press the first nine Stream Deck keys (hold works too)
		const visible = () => {
			const r = this.host.getBoundingClientRect();
			return r.bottom > 0 && r.top < innerHeight;
		};
		window.addEventListener("keydown", (ev) => {
			const n = Number(ev.key);
			if (ev.repeat || !Number.isInteger(n) || n < 1 || n > 9 || !visible() || ev.target instanceof HTMLInputElement) return;
			const key = this.keys[n - 1];
			if (key.down) return;
			this.click(0.9);
			key.down = { at: performance.now(), uid: key.session?.uid ?? null, held: false };
			const down = key.down;
			setTimeout(() => {
				if (key.down === down) {
					down.held = true;
					this.hold(key, down.uid);
				}
			}, HOLD_MS);
		});
		window.addEventListener("keyup", (ev) => {
			const n = Number(ev.key);
			if (!Number.isInteger(n) || n < 1 || n > 9) return;
			const key = this.keys[n - 1];
			if (!key.down) return;
			const { held, uid } = key.down;
			key.down = null;
			if (!held) this.press(key, uid);
		});
	}

	private setPointer(ev: PointerEvent): void {
		const rect = this.renderer.domElement.getBoundingClientRect();
		this.pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
	}

	private pick(): Key | null {
		this.raycaster.setFromCamera(this.pointer, this.camera);
		const hits = this.raycaster.intersectObjects(
			this.keys.map((k) => k.cap),
			true,
		);
		const hit = hits.find((h) => h.object.userData.key);
		return hit ? (hit.object.userData.key as Key) : null;
	}

	/** A short mechanical click, synthesised (no audio files). */
	private click(pitch: number): void {
		try {
			this.audio ??= new AudioContext();
			const ctx = this.audio;
			const len = Math.floor(ctx.sampleRate * 0.03);
			const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
			const data = buffer.getChannelData(0);
			for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
			const src = ctx.createBufferSource();
			src.buffer = buffer;
			src.playbackRate.value = pitch;
			const filter = ctx.createBiquadFilter();
			filter.type = "bandpass";
			filter.frequency.value = 2400;
			const gain = ctx.createGain();
			gain.gain.value = 0.18;
			src.connect(filter).connect(gain).connect(ctx.destination);
			src.start();
		} catch {
			// audio is a nicety
		}
	}

	private flash(key: Key, color: number): void {
		key.flash = 1;
		key.flashColor.set(color);
	}

	private press(key: Key, uid: string | null): void {
		switch (key.kind) {
			case "session":
				if (uid) {
					this.world.open(uid);
					this.flash(key, 0xffffff);
				} else this.flash(key, 0xff4b3e);
				break;
			case "hub": {
				const sessions = this.world.ordered();
				const target = sessions.find((s) => WAITING.has(s.activity)) ?? sessions.find((s) => s.activity === "done");
				if (target) this.world.open(target.uid);
				this.flash(key, 0xffffff);
				break;
			}
			case "allow":
			case "deny": {
				const target = this.world.firstApproval();
				const ok = !!target && this.world.decide(target.uid, key.kind === "allow");
				this.flash(key, ok ? (key.kind === "allow" ? 0x2fd27a : 0xff4b3e) : 0x555555);
				break;
			}
			case "page":
				this.world.toast = { text: "All sessions fit on one page", tone: "info", at: Date.now() };
				this.flash(key, 0xffffff);
				break;
		}
	}

	private hold(key: Key, uid: string | null): void {
		if (key.kind === "session" && uid && this.world.pending(uid)?.kind === "approve") {
			this.world.decide(uid, true);
			this.flash(key, 0x2fd27a);
			this.click(1.4);
			this.heldOnce = true;
			try {
				localStorage.setItem("deck-held", "1");
			} catch {
				// private mode
			}
			return;
		}
		this.press(key, uid);
	}

	// ---------------------------------------------------------------------------------------------- frames

	private resize(): void {
		const w = this.host.clientWidth;
		const h = this.host.clientHeight;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.composer.setSize(w, h);
		this.bloom.resolution.set(w, h);
		this.camera.aspect = w / h;
		this.camera.fov = w / h < 1 ? 44 : w / h < 1.4 ? 36 : 30;
		this.camera.updateProjectionMatrix();
		this.frameFor(w / h);
	}

	/** Landscape: side by side. Portrait (phones): step back and look down so both devices fit. */
	private frameFor(aspect: number): void {
		const portrait = aspect < 1;
		const home = portrait ? new THREE.Vector3(-0.1, 4.2, 8.4) : new THREE.Vector3(-0.3, 2.25, 5.5);
		const target = portrait ? new THREE.Vector3(0.18, 0.6, 0.35) : new THREE.Vector3(0.08, 0.86, 0.1);
		if (this.intro.to.distanceTo(home) < 1e-3 && this.controls.target.distanceTo(target) < 1e-3) return;
		this.intro.to.copy(home);
		this.controls.target.copy(target);
		if (performance.now() - this.intro.start > 1900) this.camera.position.copy(home);
		this.controls.minAzimuthAngle = -Infinity;
		this.controls.maxAzimuthAngle = Infinity;
		const saved = this.camera.position.clone();
		this.camera.position.copy(home);
		this.controls.update();
		this.homeAzimuth = this.controls.getAzimuthalAngle();
		this.controls.minAzimuthAngle = this.homeAzimuth - 0.85;
		this.controls.maxAzimuthAngle = this.homeAzimuth + 0.85;
		this.camera.position.copy(saved);
	}

	private drawKeys(now: number): void {
		const sessions = this.world.ordered();
		const ctxBase = { now, palette: AGENTS, animate: true, theme: this.theme };
		const approval = this.world.firstApproval();
		const approvalView = approval ? sessions.find((s) => s.uid === approval.uid) ?? null : null;
		for (const key of this.keys) {
			let svg: string;
			if (key.kind === "session") {
				const s = sessions[key.index] ?? null;
				key.session = s;
				const holding = key.down && !key.down.held && s && this.world.pending(s.uid)?.kind === "approve";
				svg = s
					? sessionTile(s, { ...ctxBase, holdProgress: holding && key.down ? Math.min(1, (performance.now() - key.down.at) / HOLD_MS) : 0 })
					: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="#050506"/><circle cx="72" cy="72" r="5" fill="#1F2227"/></svg>';
			} else if (key.kind === "hub") {
				svg = hubTile({ summary: this.world.store.summary(), pips: sessions.slice(0, 11), page: 0, pages: 1, listening: true, problem: "", connectedAgents: 4 }, ctxBase);
			} else if (key.kind === "page") {
				svg = pageTile(0, 1, sessions.length);
			} else {
				svg = decisionTile(key.kind, approvalView, ctxBase);
			}
			if (svg === key.lastSvg) continue;
			key.lastSvg = svg;
			const ticket = ++key.loading;
			const img = new Image();
			img.onload = () => {
				if (ticket !== key.loading) return;
				const c = key.ctx;
				c.clearRect(0, 0, FACE_PX, FACE_PX);
				c.save();
				roundedRectPath(c, 0, 0, FACE_PX, FACE_PX, 30);
				c.clip();
				c.drawImage(img, 0, 0, FACE_PX, FACE_PX);
				c.restore();
				key.texture.needsUpdate = true;
			};
			img.src = toDataUrl(svg);
		}
	}

	private loop = (): void => {
		if (!this.running) return;
		requestAnimationFrame(this.loop);
		const now = Date.now();
		const t = performance.now();
		this.world.tick(now);

		if (t - this.lastKeysAt > 95) {
			this.lastKeysAt = t;
			this.drawKeys(now);
		}
		if (t - this.lastScreenAt > 80) {
			this.lastScreenAt = t;
			this.screen.draw(now);
			this.screenTexture.needsUpdate = true;
		}

		// keys travel down when pressed and spring back
		for (const key of this.keys) {
			const target = key.down ? 1 : this.hovered === key ? 0.18 : 0;
			key.press += (target - key.press) * 0.35;
			key.cap.position.z = key.baseZ - 0.011 * key.press;
			key.flash *= 0.9;
			const mat = key.face.material as THREE.MeshBasicMaterial;
			mat.color.setScalar(1.18 + key.flash * 0.9);
		}

		// the light of the waiting keys spills onto the desk
		const waiting = this.world.ordered().find((s) => WAITING.has(s.activity));
		const glowColor = waiting ? AGENTS[waiting.agent].alert : "#ffb238";
		this.deckGlow.color.lerp(new THREE.Color(glowColor), 0.05);
		this.deckGlow.intensity = waiting ? 0.9 + 0.5 * Math.sin(t / 180) : 0.55;

		this.overlays();

		// fly-in, then a gentle drift while nobody touches the scene
		const k = Math.min(1, (t - this.intro.start) / 1900);
		if (k < 1) {
			const e = 1 - Math.pow(1 - k, 3);
			this.camera.position.lerpVectors(this.intro.from, this.intro.to, e);
			this.lastInteraction = t;
		} else if (t - this.lastInteraction > 6000 && this.controls.enabled) {
			const az = this.homeAzimuth + Math.sin(t / 5200) * 0.16;
			const delta = az - this.controls.getAzimuthalAngle();
			const offset = this.camera.position.clone().sub(this.controls.target);
			offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), delta * 0.02);
			this.camera.position.copy(this.controls.target).add(offset);
		}
		this.controls.update();
		this.composer.render();
	};

	/** The tooltip over the hovered key and the "Hold me" coach mark over a key waiting for approval. */
	private overlays(): void {
		const rect = this.host.getBoundingClientRect();
		const place = (el: HTMLElement, key: Key, dy: number) => {
			const p = this.keyScreenPosition(key.index);
			el.style.transform = `translate(${(p.x - rect.left).toFixed(0)}px, ${(p.y - rect.top + dy).toFixed(0)}px) translate(-50%, -100%)`;
		};
		const hovered = this.hovered;
		if (hovered && !hovered.down) {
			const s = hovered.session;
			let text = "";
			if (hovered.kind === "session") {
				if (!s) text = "<b>Empty slot</b><span>A new session takes it</span>";
				else {
					const pending = this.world.pending(s.uid);
					const action = pending?.kind === "approve" ? "Hold to allow · click to open" : pending?.kind === "ask" ? "Click to answer it" : "Click to open its terminal";
					text = `<b>${s.title.replace(/[<>&]/g, "")}</b><span>${action}</span>`;
				}
			} else if (hovered.kind === "hub") text = "<b>Overview</b><span>Click: the session that needs you</span>";
			else if (hovered.kind === "allow" || hovered.kind === "deny") text = `<b>${hovered.kind === "allow" ? "Allow" : "Deny"}</b><span>Answers the oldest request</span>`;
			else text = "<b>Next page</b><span>More sessions than keys</span>";
			if (this.tip.innerHTML !== text) this.tip.innerHTML = text;
			place(this.tip, hovered, -70);
			this.tip.classList.add("on");
		} else this.tip.classList.remove("on");

		// first visit: point at a key that waits for approval
		const approval = this.heldOnce ? null : this.world.firstApproval();
		const target = approval ? this.keys.find((k) => k.session?.uid === approval.uid) : null;
		if (target && !hovered) {
			place(this.coach, target, -58);
			this.coach.classList.add("on");
		} else this.coach.classList.remove("on");
	}

	/** Screen position of a key's centre (for tests and the hint bubble). */
	keyScreenPosition(index: number): { x: number; y: number } {
		const v = new THREE.Vector3();
		this.keys[index].cap.getWorldPosition(v);
		v.project(this.camera);
		const rect = this.renderer.domElement.getBoundingClientRect();
		return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
	}

	keyIndexOf(uid: string): number {
		return this.keys.findIndex((k) => k.session?.uid === uid);
	}
}
