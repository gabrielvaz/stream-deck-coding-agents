import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { basename } from "node:path";

export const now = () => Date.now();

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

export function clip(text, max) {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

export function firstLine(text) {
  if (typeof text !== "string") return "";
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.trim() : "";
}

export function lastLine(text) {
  if (typeof text !== "string") return "";
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length > 0 ? lines[lines.length - 1].trim() : "";
}

export function projectName(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return "";
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return basename(trimmed) || trimmed;
}

export function lanAddresses() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) out.push(info.address);
    }
  }
  return out;
}

export function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("bad_json"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(text);
}

export function isLoopback(address) {
  if (typeof address !== "string") return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address === "localhost";
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hslToHex(h, s = 0.8, l = 0.6) {
  const hue = ((Number(h) % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const color = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

/** Truncates without collapsing inner whitespace (tool labels keep their double space). */
export function truncate(text, max) {
  if (typeof text !== "string") return "";
  const flat = text.replace(/[\r\n\t]+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}
