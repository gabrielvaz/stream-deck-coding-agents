// Renders docs/screenshot.png and docs/focus.png from the demo server (needs Playwright + Chromium).
//   node bin/agent-deck.mjs demo --port 7792 --no-token &   then   node docs/screenshot.mjs http://127.0.0.1:7792
import { createRequire } from "node:module";
import { join } from "node:path";

// PLAYWRIGHT_DIR lets you point at any directory that has playwright installed.
const require = createRequire(
  process.env.PLAYWRIGHT_DIR ? join(process.env.PLAYWRIGHT_DIR, "package.json") : import.meta.url,
);
const { chromium } = require("playwright");

const base = process.argv[2] || "http://127.0.0.1:7792";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelectorAll(".key:not(.empty)").length >= 6, null, { timeout: 30000 });
await page.waitForTimeout(9000);
await page.screenshot({ path: new URL("./screenshot.png", import.meta.url).pathname });
// open the first waiting tile (or the first tile) in focus mode
const waiting = await page.$('.screen[data-state="waitingPermission"]');
if (waiting) await waiting.click();
else await page.click(".key:not(.empty)");
await page.waitForTimeout(600);
await page.screenshot({ path: new URL("./focus.png", import.meta.url).pathname });
await browser.close();
if (errors.length) {
  console.error("page errors:", errors);
  process.exit(1);
}
console.log("wrote docs/screenshot.png and docs/focus.png");
