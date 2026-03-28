import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setupYouTube } from "./platforms/youtube.js";
import { setupXSpaces } from "./platforms/x-spaces.js";
import { setupZoom } from "./platforms/zoom.js";

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http"));
const headed = args.includes("--headed");
const verbose = args.includes("--verbose");
const useAuth = args.includes("--auth");

const durationIdx = args.indexOf("--duration");
const durationMs = durationIdx >= 0 ? parseDuration(args[durationIdx + 1]) : null;

const channelIdx = args.indexOf("--channel");
const channel = channelIdx >= 0 ? args[channelIdx + 1] : null;

const targetIdx = args.indexOf("--target");
const target = targetIdx >= 0 ? args[targetIdx + 1] : null;

const keywords: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--keyword" && args[i + 1]) {
    keywords.push(args[i + 1].toLowerCase());
  }
}

if (!url) {
  console.error("Usage: hawk join <url> [--headed] [--duration 30m] [--keyword <word>] [--auth] [--verbose]");
  console.error("Supported: YouTube Live, X Spaces, Zoom Webinar");
  process.exit(1);
}

// ─── Platform detection ──────────────────────────────────────────────────────

type Platform = "youtube" | "x-spaces" | "zoom" | "unknown";

function detectPlatform(u: string): Platform {
  if (/youtube\.com|youtu\.be/.test(u)) return "youtube";
  if (/twitter\.com\/i\/spaces|x\.com\/i\/spaces/.test(u)) return "x-spaces";
  if (/zoom\.us/.test(u)) return "zoom";
  return "unknown";
}

function extractStreamId(u: string, platform: Platform): string {
  if (platform === "youtube") {
    const m =
      u.match(/[?&]v=([^&]+)/) ||
      u.match(/youtu\.be\/([^?/]+)/) ||
      u.match(/\/live\/([^?/]+)/);
    return m?.[1] ?? "yt-unknown";
  }
  if (platform === "x-spaces") {
    const m = u.match(/spaces\/([^?/]+)/);
    return m?.[1] ?? "space-unknown";
  }
  if (platform === "zoom") {
    const m = u.match(/\/j\/(\d+)/) || u.match(/\/w\/(\d+)/) || u.match(/\/wc\/(\d+)/);
    return m?.[1] ?? "zoom-unknown";
  }
  return "unknown";
}

function parseDuration(s: string): number | null {
  const m = s?.match(/^(\d+)(ms|s|m|h)$/);
  if (!m) return null;
  const n = parseInt(m[1]);
  const unit = m[2];
  if (unit === "ms") return n;
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60_000;
  if (unit === "h") return n * 3_600_000;
  return null;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const platform = detectPlatform(url);
const streamId = extractStreamId(url, platform);
const today = new Date().toISOString().slice(0, 10);

const workspaceDir = join(homedir(), ".openclaw", "workspace", "hawk");
const transcriptDir = join(workspaceDir, "transcripts");
const transcriptPath = join(transcriptDir, `${streamId}-${today}.txt`);
const screenshotPath = join(workspaceDir, "on-demand-screenshot.png");
const joinedPath = join(workspaceDir, "joined-stream.png");
const debugPath = join(workspaceDir, "debug-join-failed.png");
const pidPath = join(workspaceDir, "hawk.pid");
const authPath = join(homedir(), ".hawk", "auth.json");

mkdirSync(transcriptDir, { recursive: true });
writeFileSync(pidPath, String(process.pid));

// ─── Transcript helpers ──────────────────────────────────────────────────────

let lastCaption = "";
const seenChat = new Set<string>();

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function writeTranscript(line: string): void {
  appendFileSync(transcriptPath, line + "\n");
  if (verbose) process.stdout.write(line + "\n");
}

function onCaption(text: string): void {
  text = text.trim();
  if (!text) return;
  // Deduplicate: skip if new text is just a mid-word extension of the last
  if (lastCaption && text.startsWith(lastCaption) && text.length - lastCaption.length < 8) {
    lastCaption = text;
    return;
  }
  if (text === lastCaption) return;
  lastCaption = text;
  writeTranscript(`[${timestamp()}] 🎙️  ${text}`);
  checkKeywords(text);
}

function onChat(user: string, text: string): void {
  text = text.trim();
  user = user.trim();
  if (!text || !user) return;
  const key = `${user}:${text}`;
  if (seenChat.has(key)) return;
  seenChat.add(key);
  writeTranscript(`[${timestamp()}] 💬 ${user}: ${text}`);
  checkKeywords(text);
}

function checkKeywords(text: string): void {
  if (keywords.length === 0) return;
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      console.log(`[HAWK_KEYWORD] "${kw}" mentioned: ${text}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (platform === "unknown") {
    console.error(`[Hawk] Unsupported URL: ${url}`);
    console.error("Supported: YouTube Live, X Spaces (twitter.com/i/spaces/...), Zoom (zoom.us/j/...)");
    process.exit(1);
  }

  console.log(`[Hawk] Platform : ${platform}`);
  console.log(`[Hawk] Stream ID: ${streamId}`);
  console.log(`[Hawk] Transcript: ${transcriptPath}`);
  if (keywords.length > 0) console.log(`[Hawk] Watching for: ${keywords.join(", ")}`);

  const browser = await chromium.launch({
    headless: !headed,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  };

  // Load saved auth if requested
  if (useAuth && existsSync(authPath)) {
    const authData = JSON.parse(readFileSync(authPath, "utf8"));
    if (authData.cookies) contextOptions.storageState = authPath;
    console.log("[Hawk] Using saved auth session");
  }

  const context = await browser.newContext(contextOptions);

  // Stealth: override headless detection signals
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  // Expose transcript callbacks — available in ALL frames including iframes
  await page.exposeFunction("hawkOnCaption", onCaption);
  await page.exposeFunction("hawkOnChat", onChat);

  // ── SIGUSR1: on-demand screenshot ─────────────────────────────────────────
  process.on("SIGUSR1", async () => {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`[HAWK_SCREENSHOT] ${screenshotPath}`);
    } catch (e) {
      console.error("[Hawk] Screenshot failed:", e);
    }
  });

  try {
    if (platform === "youtube") {
      await setupYouTube(page, url, { verbose });
    } else if (platform === "x-spaces") {
      await setupXSpaces(page, url, { verbose });
    } else if (platform === "zoom") {
      await setupZoom(page, url, { verbose });
    }

    // Confirmation screenshot
    await page.screenshot({ path: joinedPath });
    console.log(`[HAWK_SUCCESS_IMAGE] ${joinedPath}`);
    console.log(`[Hawk] Live. Press Ctrl+C to stop.\n`);

    // Auto-leave after duration
    if (durationMs) {
      setTimeout(() => cleanup(browser, "Duration reached"), durationMs);
    }

    // Poll for stream end every 30s
    const endPoll = setInterval(async () => {
      try {
        if (platform === "youtube") {
          const ended = await page.evaluate(() => {
            const video = document.querySelector<HTMLVideoElement>("video");
            const endedOverlay = document.querySelector(".ytp-error, .ytp-ended-overlay");
            return !!endedOverlay || (!!video && video.ended && video.currentTime > 0);
          });
          if (ended) {
            clearInterval(endPoll);
            cleanup(browser, "Stream ended");
          }
        }
      } catch {
        // page may have navigated or closed
      }
    }, 30_000);

  } catch (err) {
    console.error("[Hawk] Error joining stream:", err);
    try {
      await page.screenshot({ path: debugPath });
      console.log(`[HAWK_DEBUG_IMAGE] ${debugPath}`);
    } catch {}
    await browser.close();
    process.exit(1);
  }
}

async function cleanup(browser: Browser, reason: string): Promise<void> {
  console.log(`[Hawk] Stopping: ${reason}`);
  console.log(`[HAWK_TRANSCRIPT] ${transcriptPath}`);
  try {
    await browser.close();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => cleanup(null as unknown as Browser, "SIGTERM"));
process.on("SIGINT", () => cleanup(null as unknown as Browser, "SIGINT"));

main();
