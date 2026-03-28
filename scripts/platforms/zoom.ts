import type { Page } from "playwright-core";

interface ZoomOptions {
  verbose?: boolean;
  onCommand?: (message: string) => string | null;
}

export async function setupZoom(page: Page, url: string, opts: ZoomOptions): Promise<void> {
  const { verbose, onCommand } = opts;

  const wcUrl = normalizeZoomUrl(url);
  if (verbose) console.log(`[Zoom] Navigating to: ${wcUrl}`);

  await page.goto(wcUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Detect sign-in redirect (host /start link used instead of join link)
  if (page.url().includes("/signin") || page.url().includes("/login")) {
    throw new Error(
      "Zoom redirected to sign-in. Use a participant join link (zoom.us/j/ID), not a /start link."
    );
  }

  // "Join from your Browser" link — Zoom shows app download prompt first
  try {
    const browserJoinLink = page.locator(
      'a:has-text("Join from Your Browser"), a:has-text("join from your browser"), [id*="joinBrowser"]'
    ).first();
    await browserJoinLink.waitFor({ timeout: 10_000 });
    await browserJoinLink.click();
    if (verbose) console.log("[Zoom] Clicked 'Join from Browser'");
  } catch {
    if (verbose) console.log("[Zoom] Already on web client");
  }

  // Fill in name and click Join
  try {
    // Wait for name input — try multiple selectors
    const nameInput = page.locator(
      'input[type="text"], input[placeholder*="name" i], input[id*="name" i]'
    ).first();
    await nameInput.waitFor({ timeout: 8_000 });
    await nameInput.click();
    await nameInput.fill("Hawk Bot");
    if (verbose) console.log("[Zoom] Entered display name: Hawk Bot");

    await page.waitForTimeout(500);

    // Click Join button
    const joinBtn = page.locator(
      'button:has-text("Join"), button[id*="join" i], input[value*="Join" i]'
    ).first();
    await joinBtn.waitFor({ timeout: 5_000 });
    await joinBtn.click();
    if (verbose) console.log("[Zoom] Clicked Join");
  } catch {
    if (verbose) console.log("[Zoom] Name/join prompt not shown — already in meeting");
  }

  // Wait for the meeting UI
  try {
    await page.waitForSelector(
      '[class*="meeting-client"], [class*="footer"], .zm-btn, [class*="toolbar"]',
      { timeout: 30_000 }
    );
    if (verbose) console.log("[Zoom] Meeting UI loaded");
  } catch {
    if (verbose) console.log("[Zoom] Meeting UI load timeout — proceeding anyway");
  }

  // Dismiss audio prompt
  try {
    const audioBtn = page.locator(
      'button:has-text("Join Audio"), button:has-text("Join with Computer Audio"), button:has-text("OK")'
    ).first();
    await audioBtn.click({ timeout: 4_000 });
    if (verbose) console.log("[Zoom] Dismissed audio prompt");
  } catch {}

  // Enable captions if available
  try {
    const ccBtn = page.locator(
      'button[aria-label*="caption" i], button[aria-label="CC"], button:has-text("CC"), [class*="cc-button"]'
    ).first();
    await ccBtn.click({ timeout: 6_000 });
    if (verbose) console.log("[Zoom] Clicked captions button");
    await page.waitForTimeout(1_000);
  } catch {
    if (verbose) console.log("[Zoom] CC button not found — host may not have enabled captions");
  }

  // Caption polling — passed as string so esbuild never transforms it (avoids __name error)
  try {
    await page.evaluate(`
      (() => {
        var SELECTORS = [
          ".live-caption-entity",
          ".zmwebsdk-MuiBox-root[aria-live]",
          "[class*='caption-entity']",
          "[class*='caption-text']",
          "[class*='caption-view']",
          "[id*='caption']"
        ];
        var lastSent = "";
        setInterval(function() {
          for (var i = 0; i < SELECTORS.length; i++) {
            var el = document.querySelector(SELECTORS[i]);
            if (el) {
              var text = (el.textContent || "").trim();
              if (text && text !== lastSent && text.length > 3) {
                lastSent = text;
                window.hawkOnCaption(text);
              }
              return;
            }
          }
        }, 800);
      })();
    `);
    if (verbose) console.log("[Zoom] Caption polling active");
  } catch (err) {
    console.error("[Zoom] Caption polling setup failed:", err);
  }

  // ── Chat watch + @hawk reply ──────────────────────────────────────────────
  if (onCommand) {
    // Expose the command handler so the browser can call it
    // Node.js-side frame scanner — strict filter to avoid false positives from participant names
    const seen = new Set<string>();
    setInterval(async () => {
      for (const frame of page.frames()) {
        try {
          const messages = await frame.evaluate(`
            (() => {
              var els = Array.from(document.querySelectorAll("p, span, div, li"));
              var results = [];
              els.forEach(function(el) {
                if (el.children.length > 1) return;
                var text = (el.textContent || "").trim();
                // Must start with @hawk or be the accessibility "chat from X" pattern
                var lower = text.toLowerCase();
                var isCmd = lower.indexOf("@hawk") === 0;
                var isAccessibility = lower.indexOf("chat from") === 0 && lower.indexOf("@hawk") !== -1;
                if (isCmd || isAccessibility) results.push(text);
              });
              return results;
            })()
          `) as string[];

          for (const msg of messages) {
            // Extract just the @hawk command from accessibility strings like "chat from X to Everyone @hawk help"
            const cmdMatch = msg.match(/@hawk\s*.*/i);
            if (!cmdMatch) continue;
            const cmd = cmdMatch[0].trim();
            if (seen.has(cmd)) continue;
            seen.add(cmd);
            if (verbose) console.log(`[Zoom] Command detected: "${cmd}"`);
            const reply = onCommand(cmd);
            if (reply) {
              if (verbose) console.log(`[Zoom] Replying in chat...`);
              sendZoomChatMessage(page, reply).catch((e) => {
                console.error("[Zoom] Failed to send reply:", e);
              });
            }
          }
        } catch {}
      }
    }, 1_000);

    if (verbose) console.log("[Zoom] Chat command watcher active — type @hawk help in meeting chat");
  }
}

// ── Type a message into Zoom chat ─────────────────────────────────────────────
async function sendZoomChatMessage(page: Page, text: string, _verbose?: boolean): Promise<void> {
  // Ensure the chat panel is open by clicking the Chat button in the toolbar
  try {
    const chatBtn = page.locator(
      'button[aria-label="Chat"], [class*="chat-button"], button:has-text("Chat")'
    ).first();
    await chatBtn.click({ timeout: 2_000 });
    await page.waitForTimeout(500);
  } catch {}

  const SELECTORS = [
    "textarea[placeholder*='message' i]",
    "textarea[placeholder*='here' i]",
    "textarea[placeholder*='chat' i]",
    "[class*='chat'] textarea",
    "textarea",
  ];

  // Scan all frames — Zoom puts chat input in a sub-frame
  for (const frame of page.frames()) {
    for (const sel of SELECTORS) {
      try {
        const input = frame.locator(sel).first();
        await input.waitFor({ timeout: 1_500 });
        await input.click();
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          await input.fill(line);
          await page.keyboard.press("Enter");
          await page.waitForTimeout(400);
        }
        console.log("[Zoom] Reply sent.");
        return;
      } catch {}
    }
  }
  console.error("[Zoom] Could not find chat input to send reply.");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeZoomUrl(url: string): string {
  if (url.includes("/wc/")) return url;

  const meetingIdMatch = url.match(/\/j\/(\d+)/) || url.match(/\/w\/(\d+)/);
  if (!meetingIdMatch) return url;

  const meetingId = meetingIdMatch[1];
  const pwdMatch = url.match(/[?&]pwd=([^&]+)/);
  const pwd = pwdMatch ? `?pwd=${pwdMatch[1]}` : "";

  // Preserve subdomain (e.g. txstate.zoom.us, company.zoom.us)
  const hostMatch = url.match(/https?:\/\/([^/]+)/);
  const host = hostMatch ? hostMatch[1] : "zoom.us";

  return `https://${host}/wc/${meetingId}/join${pwd}`;
}
