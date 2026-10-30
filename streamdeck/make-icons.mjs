// Generates the PNG icons the Stream Deck manifest needs (no dependencies: tiny PNG encoder).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "com.gabrielvaz.coding-agents.sdPlugin", "imgs");
mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const hex = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const inRounded = (x, y, r) => {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return Math.sqrt(dx * dx + dy * dy) <= r;
};

function tile(orb, opts = {}) {
  const base = hex("#15171b");
  const screen = hex("#050607");
  const glow = hex(orb);
  return (x, y) => {
    if (!inRounded(x, y, 0.2)) return [0, 0, 0, 0];
    const sx = (x - 0.09) / 0.82;
    const sy = (y - 0.09) / 0.82;
    let c = base;
    if (sx >= 0 && sx <= 1 && sy >= 0 && sy <= 1 && inRounded(sx, sy, 0.16)) {
      const d = Math.hypot(sx - 0.5, sy - 1.05);
      const g = Math.max(0, 1 - d / 0.62) ** 1.6;
      c = mix(screen, glow, g);
      const core = Math.max(0, 1 - d / 0.22) ** 1.2;
      c = mix(c, [255, 255, 255], core * 0.9);
      if (opts.bar && sy > 0.14 && sy < 0.22 && sx > 0.12 && sx < 0.72) c = [230, 232, 236];
      if (opts.bar && sy > 0.28 && sy < 0.34 && sx > 0.12 && sx < 0.5) c = mix(glow, [255, 255, 255], 0.2);
    }
    return [...c, 255];
  };
}
function badge(color, symbol) {
  const bg = hex("#15171b");
  const fg = hex(color);
  return (x, y) => {
    if (!inRounded(x, y, 0.22)) return [0, 0, 0, 0];
    let c = bg;
    if (symbol === "check") {
      const on = (Math.abs(y - (1.1 - x) - 0.02) < 0.07 && x > 0.45 && x < 0.78) || (Math.abs(y - (x + 0.2)) < 0.07 && x > 0.28 && x < 0.47);
      if (on) c = fg;
    } else if (symbol === "cross") {
      if ((Math.abs(x - y) < 0.07 || Math.abs(x + y - 1) < 0.07) && x > 0.28 && x < 0.72) c = fg;
    } else if (symbol === "arrow") {
      if ((Math.abs(y - 0.5) < 0.06 && x > 0.25 && x < 0.65) || (Math.abs(Math.abs(y - 0.5) - (0.75 - x)) < 0.06 && x > 0.5 && x < 0.76)) c = fg;
    } else if (symbol === "grid") {
      const gx = (x - 0.2) / 0.6;
      const gy = (y - 0.2) / 0.6;
      if (gx >= 0 && gx <= 1 && gy >= 0 && gy <= 1) {
        const cx = (gx * 3) % 1;
        const cy = (gy * 3) % 1;
        if (cx > 0.12 && cx < 0.88 && cy > 0.12 && cy < 0.88) {
          const i = Math.floor(gx * 3) + Math.floor(gy * 3) * 3;
          const colors = ["#F3B257", "#5B8DFF", "#35E3A2", "#E2714B", "#A68CFF", "#E9E9EC", "#5B8DFF", "#F3B257", "#35E3A2"];
          c = hex(colors[i]);
        }
      }
    }
    return [...c, 255];
  };
}

const icons = {
  plugin: badge("#35E3A2", "grid"),
  category: badge("#35E3A2", "grid"),
  session: tile("#F3B257", { bar: true }),
  hub: tile("#35E3A2", { bar: true }),
  allow: badge("#35E3A2", "check"),
  deny: badge("#FF4F4F", "cross"),
  page: badge("#C9CCD1", "arrow"),
};
for (const [name, pixel] of Object.entries(icons)) {
  writeFileSync(join(OUT, `${name}.png`), png(72, pixel));
  writeFileSync(join(OUT, `${name}@2x.png`), png(144, pixel));
}
console.log(`wrote ${Object.keys(icons).length * 2} icons to ${OUT}`);
