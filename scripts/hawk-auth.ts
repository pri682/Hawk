/**
 * hawk auth — save a browser session for private X Spaces or Zoom webinars.
 * Opens a headed browser, lets you sign in, then saves cookies/storage to ~/.hawk/auth.json.
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const platform = args[0] ?? "x"; // default to X/Twitter auth

const authDir = join(homedir(), ".hawk");
const authPath = join(authDir, "auth.json");
const metaPath = join(authDir, "auth-meta.json");

mkdirSync(authDir, { recursive: true });

const LOGIN_URLS: Record<string, string> = {
  x: "https://x.com/login",
  twitter: "https://twitter.com/login",
  zoom: "https://zoom.us/signin",
};

const loginUrl = LOGIN_URLS[platform] ?? LOGIN_URLS["x"];

console.log(`Opening browser for ${platform} login...`);
console.log("Sign in, then come back here and press Enter to save your session.\n");

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 800 },
});

const page = await context.newPage();
await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

// Wait for user to sign in
const rl = createInterface({ input: process.stdin, output: process.stdout });
await new Promise<void>((resolve) => {
  rl.question("Press Enter after signing in to save your session: ", () => {
    rl.close();
    resolve();
  });
});

// Save storage state (cookies + localStorage)
const storageState = await context.storageState();
writeFileSync(authPath, JSON.stringify(storageState, null, 2));

// Save metadata (which account / platform)
let email = "";
try {
  if (platform === "x" || platform === "twitter") {
    email = (await page.evaluate(() => {
      // Try to get the logged-in username from the page
      const el =
        document.querySelector('[data-testid="UserName"]') ??
        document.querySelector('[aria-label*="Account menu"]');
      return el?.textContent?.trim() ?? "";
    })) ?? "";
  }
} catch {}

writeFileSync(
  metaPath,
  JSON.stringify({ platform, email: email || "unknown", savedAt: new Date().toISOString() }, null, 2)
);

await browser.close();

console.log(`\nSession saved to ${authPath}`);
if (email) console.log(`Logged in as: ${email}`);
console.log("\nYou can now use `hawk join <url> --auth` to join with this session.");
