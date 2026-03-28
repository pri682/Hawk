import type { Page } from "playwright-core";

interface YouTubeOptions {
  verbose?: boolean;
}

/**
 * YouTube Live: enable CC, observe captions + live chat.
 * Calls window.hawkOnCaption(text) and window.hawkOnChat(user, text)
 * which are exposed from hawk-join.ts via page.exposeFunction.
 */
export async function setupYouTube(page: Page, url: string, opts: YouTubeOptions): Promise<void> {
  const { verbose } = opts;

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

  // Enable CC — click the subtitles button if not already active
  try {
    const ccBtn = page.locator("button.ytp-subtitles-button");
    await ccBtn.waitFor({ timeout: 8_000 });
    const pressed = await ccBtn.getAttribute("aria-pressed");
    if (pressed !== "true") {
      await ccBtn.click();
      if (verbose) console.log("[YouTube] Captions enabled");
    } else {
      if (verbose) console.log("[YouTube] Captions already on");
    }
  } catch {
    if (verbose) console.log("[YouTube] CC button not found — stream may not have captions");
  }

  // ── Caption MutationObserver ──────────────────────────────────────────────
  await page.evaluate(() => {
    const captionContainer = document.querySelector(".ytp-caption-window-container");
    if (!captionContainer) {
      console.warn("[Hawk/YouTube] Caption container not found — captions may load later");
      // Retry once the CC overlay appears
      const retryObserver = new MutationObserver(() => {
        const c = document.querySelector(".ytp-caption-window-container");
        if (c) {
          retryObserver.disconnect();
          attachCaptionObserver(c);
        }
      });
      retryObserver.observe(document.body, { childList: true, subtree: true });
      return;
    }
    attachCaptionObserver(captionContainer);

    function attachCaptionObserver(container: Element) {
      let lastSent = "";
      const observer = new MutationObserver(() => {
        const segments = Array.from(document.querySelectorAll(".ytp-caption-segment"));
        const text = segments
          .map((s) => s.textContent ?? "")
          .join(" ")
          .trim();
        if (text && text !== lastSent) {
          lastSent = text;
          (window as any).hawkOnCaption(text);
        }
      });
      observer.observe(container, { childList: true, subtree: true, characterData: true });
    }
  });

  if (verbose) console.log("[YouTube] Caption observer active");

  // ── Live chat MutationObserver ────────────────────────────────────────────
  // The chat is in an iframe (youtube.com/live_chat).
  // page.exposeFunction exposes hawkOnChat to ALL frames, so we can call it from within the iframe.
  try {
    await page.waitForSelector("iframe#chatframe", { timeout: 10_000 });

    const chatFrameEl = await page.$("iframe#chatframe");
    const chatFrame = chatFrameEl ? await chatFrameEl.contentFrame() : null;

    if (chatFrame) {
      // Wait for chat messages container
      await chatFrame.waitForSelector(
        "#items.yt-live-chat-item-list-renderer, #chat-messages",
        { timeout: 10_000 }
      );

      await chatFrame.evaluate(() => {
        const container =
          document.querySelector("#items.yt-live-chat-item-list-renderer") ??
          document.querySelector("#chat-messages");

        if (!container) return;

        const seen = new Set<string>();

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of Array.from(mutation.addedNodes)) {
              if (!(node instanceof Element)) continue;

              // Text messages
              if (
                node.tagName?.toLowerCase() === "yt-live-chat-text-message-renderer" ||
                node.querySelector("yt-live-chat-text-message-renderer")
              ) {
                const msgEl =
                  node.tagName?.toLowerCase() === "yt-live-chat-text-message-renderer"
                    ? node
                    : node.querySelector("yt-live-chat-text-message-renderer")!;

                const id = msgEl.getAttribute("id") ?? msgEl.textContent?.slice(0, 40) ?? "";
                if (seen.has(id)) continue;
                seen.add(id);

                const author =
                  msgEl.querySelector("#author-name")?.textContent?.trim() ?? "viewer";
                const message =
                  msgEl.querySelector("#message")?.textContent?.trim() ?? "";

                if (message) {
                  (window as any).hawkOnChat(author, message);
                }
              }

              // Super chats / donations
              if (node.tagName?.toLowerCase() === "yt-live-chat-paid-message-renderer") {
                const author =
                  node.querySelector("#author-name")?.textContent?.trim() ?? "viewer";
                const amount =
                  node.querySelector("#purchase-amount")?.textContent?.trim() ?? "";
                const message =
                  node.querySelector("#message")?.textContent?.trim() ?? "";
                const id = `superchat:${author}:${amount}`;
                if (!seen.has(id)) {
                  seen.add(id);
                  (window as any).hawkOnChat(
                    `💰 ${author}`,
                    `${amount}${message ? " — " + message : ""}`
                  );
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
}
