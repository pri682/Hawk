import type { Page } from "playwright-core";

interface YouTubeOptions {
  verbose?: boolean;
  onCommand?: (message: string) => string | null;
}

/**
 * YouTube Live: enable CC, observe captions + live chat.
 * Calls window.hawkOnCaption(text) and window.hawkOnChat(user, text)
 * which are exposed from hawk-join.ts via page.exposeFunction.
 */
export async function setupYouTube(page: Page, url: string, opts: YouTubeOptions): Promise<void> {
  const { verbose, onCommand } = opts;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Dismiss cookie consent (EU)
  try {
    const consent = page.locator("button[aria-label*='Accept'], form[action*='consent'] button").first();
    await consent.click({ timeout: 4_000 });
    if (verbose) console.log("[YouTube] Dismissed cookie consent");
  } catch {}

  // Wait for the video player
  await page.waitForSelector(".html5-video-player", { timeout: 30_000 });
  if (verbose) console.log("[YouTube] Player loaded");

  // Give the player a moment to settle before interacting
  await page.waitForTimeout(2_000);

  // Enable captions via keyboard shortcut 'c' — more reliable than clicking the CC button
  // which can open a settings panel instead of toggling on/off
  try {
    await page.click(".html5-video-player");
    await page.waitForTimeout(500);
    await page.keyboard.press("c");
    if (verbose) console.log("[YouTube] Pressed 'c' to enable captions");
    await page.waitForTimeout(1_000);
  } catch {
    if (verbose) console.log("[YouTube] Could not enable captions via keyboard");
  }

  // ── Caption polling — string literal avoids esbuild __name injection ─────
  try {
    await page.evaluate(`
      (() => {
        var lastSent = "";
        setInterval(function() {
          var segments = Array.from(document.querySelectorAll(".ytp-caption-segment"));
          var text = segments.map(function(s) { return s.textContent || ""; }).join(" ").trim();
          if (text && text !== lastSent) {
            lastSent = text;
            window.hawkOnCaption(text);
          }
        }, 800);
      })();
    `);
    if (verbose) console.log("[YouTube] Caption polling active");
  } catch (err) {
    console.error("[YouTube] Caption polling setup failed:", err);
  }

  // ── Live chat MutationObserver ────────────────────────────────────────────
  try {
    await page.waitForSelector("iframe#chatframe", { timeout: 10_000 });

    const chatFrameEl = await page.$("iframe#chatframe");
    const chatFrame = chatFrameEl ? await chatFrameEl.contentFrame() : null;

    if (chatFrame) {
      await chatFrame.waitForSelector(
        "#items.yt-live-chat-item-list-renderer, #chat-messages",
        { timeout: 10_000 }
      );

      await chatFrame.evaluate(() => {
        const container =
          document.querySelector("#items.yt-live-chat-item-list-renderer") ||
          document.querySelector("#chat-messages");

        if (!container) return;

        const seen = new Set();

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of Array.from(mutation.addedNodes)) {
              if (!(node instanceof Element)) continue;

              // Standard text messages
              const isTextMsg =
                node.tagName.toLowerCase() === "yt-live-chat-text-message-renderer" ||
                !!node.querySelector("yt-live-chat-text-message-renderer");

              if (isTextMsg) {
                const msgEl =
                  node.tagName.toLowerCase() === "yt-live-chat-text-message-renderer"
                    ? node
                    : node.querySelector("yt-live-chat-text-message-renderer");

                if (!msgEl) continue;
                const id = msgEl.getAttribute("id") || msgEl.textContent.slice(0, 40);
                if (seen.has(id)) continue;
                seen.add(id);

                const author = (msgEl.querySelector("#author-name") || {}).textContent || "viewer";
                const message = (msgEl.querySelector("#message") || {}).textContent || "";
                if (message.trim()) {
                  (window as any).hawkOnChat(author.trim(), message.trim());
                  // Check for @hawk commands
                  const lower = message.toLowerCase().trim();
                  if (lower.includes("@hawk") || lower.startsWith("hawk ")) {
                    (window as any).hawkOnCommand(message.trim());
                  }
                }
              }

              // Super chats
              if (node.tagName.toLowerCase() === "yt-live-chat-paid-message-renderer") {
                const author = (node.querySelector("#author-name") || {}).textContent || "viewer";
                const amount = (node.querySelector("#purchase-amount") || {}).textContent || "";
                const message = (node.querySelector("#message") || {}).textContent || "";
                const id = "superchat:" + author + amount;
                if (!seen.has(id)) {
                  seen.add(id);
                  const text = amount + (message.trim() ? " — " + message.trim() : "");
                  (window as any).hawkOnChat("💰 " + author.trim(), text);
                }
              }
            }
          }
        });

        observer.observe(container, { childList: true });
      });

      if (verbose) console.log("[YouTube] Live chat observer active");
    }
  } catch {
    if (verbose) console.log("[YouTube] Live chat not available for this stream");
  }

  // ── @hawk command replies in YouTube chat (requires auth/signed-in session) ──
  if (onCommand) {
    await page.exposeFunction("hawkOnCommand", (msg: string) => {
      const reply = onCommand(msg);
      if (reply) {
        sendYouTubeChatMessage(page, reply).catch(() => {});
      }
    });
    if (verbose) console.log("[YouTube] Chat command watcher active — type @hawk help in live chat");
  }
}

// ── Type a message into YouTube live chat ─────────────────────────────────────
async function sendYouTubeChatMessage(page: Page, text: string): Promise<void> {
  try {
    const chatFrameEl = await page.$("iframe#chatframe");
    const chatFrame = chatFrameEl ? await chatFrameEl.contentFrame() : null;
    if (!chatFrame) return;

    const input = chatFrame.locator("#input[contenteditable]").first();
    await input.waitFor({ timeout: 3_000 });

    // YouTube chat uses a contenteditable div, not a textarea
    for (const line of text.split("\n")) {
      await input.click();
      await input.fill(line);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
    }
  } catch {}
}
