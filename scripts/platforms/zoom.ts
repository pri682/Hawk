import type { Page } from "playwright-core";

interface ZoomOptions {
  verbose?: boolean;
}

/**
 * Zoom Webinar (view-only browser join).
 * Joins via the Zoom Web Client (no app download needed for view-only webinars).
 * Captures live captions if the host has them enabled.
 *
 * Calls window.hawkOnCaption(text) exposed from hawk-join.ts.
 */
export async function setupZoom(page: Page, url: string, opts: ZoomOptions): Promise<void> {
  const { verbose } = opts;

  // Convert meeting links to web client format
  // e.g. https://zoom.us/j/12345678?pwd=abc → https://zoom.us/wc/12345678/join
  const wcUrl = normalizeZoomUrl(url);
  if (verbose) console.log(`[Zoom] Navigating to: ${wcUrl}`);

  await page.goto(wcUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // ── "Join from your Browser" link ────────────────────────────────────────
  // Zoom shows an app download prompt first. We click the browser join link.
  try {
    const browserJoinLink = page.locator(
      'a:has-text("Join from Your Browser"), a:has-text("join from your browser"), [id*="joinBrowser"]'
    ).first();
    await browserJoinLink.waitFor({ timeout: 10_000 });
    await browserJoinLink.click();
    if (verbose) console.log("[Zoom] Clicked 'Join from Browser'");
  } catch {
    // May already be on the web client page
    if (verbose) console.log("[Zoom] Already on web client or link not found");
  }

  // ── Fill in name if prompted ──────────────────────────────────────────────
  try {
    const nameInput = page.locator('input[placeholder*="name" i], input[id*="inputname" i]').first();
    await nameInput.waitFor({ timeout: 6_000 });
    await nameInput.fill("Hawk Bot");
    if (verbose) console.log("[Zoom] Entered display name");

    const joinBtn = page.locator('button:has-text("Join"), input[value="Join"]').first();
    await joinBtn.click({ timeout: 5_000 });
    if (verbose) console.log("[Zoom] Clicked join button");
  } catch {
    if (verbose) console.log("[Zoom] Name prompt not shown — may be a public webinar");
  }

  // ── Wait for the Zoom meeting UI to load ─────────────────────────────────
  try {
    await page.waitForSelector(
      '[class*="meeting-client"], [id="wc-container-right"], .zm-btn, [class*="footer-button"]',
      { timeout: 30_000 }
    );
    if (verbose) console.log("[Zoom] Meeting UI loaded");
  } catch {
    if (verbose) console.log("[Zoom] Meeting UI may not have loaded fully — proceeding anyway");
  }

  // ── Dismiss any entry prompts (audio, video) ──────────────────────────────
  try {
    // "Join with Computer Audio" or dismiss audio settings
    const audioBtn = page.locator(
      'button:has-text("Join Audio"), button:has-text("Join with Computer Audio"), button[aria-label*="audio" i]'
    ).first();
    await audioBtn.click({ timeout: 4_000 });
    if (verbose) console.log("[Zoom] Dismissed audio prompt");
  } catch {}

  try {
    // Close any modal / "Got it" banners
    const gotIt = page.locator('button:has-text("Got it"), button:has-text("OK"), button:has-text("Close")').first();
    await gotIt.click({ timeout: 3_000 });
  } catch {}

  // ── Enable closed captions if available ──────────────────────────────────
  try {
    // Zoom CC button is in the toolbar, sometimes labelled "CC" or "Captions"
    const ccBtn = page.locator(
      'button[aria-label*="caption" i], button[aria-label="CC"], button:has-text("CC"), [class*="cc-button"]'
    ).first();
    await ccBtn.click({ timeout: 6_000 });
    if (verbose) console.log("[Zoom] Clicked captions button");
    await page.waitForTimeout(1_000);
  } catch {
    if (verbose) console.log("[Zoom] CC button not found — host may not have enabled captions");
  }

  // ── Caption MutationObserver ──────────────────────────────────────────────
  await page.evaluate(() => {
    const CAPTION_SELECTORS = [
      // Zoom web client caption panel
      ".live-caption-entity",
      ".zmwebsdk-MuiBox-root[aria-live]",
      "[class*='caption-entity']",
      "[class*='caption-text']",
      '[aria-live="polite"]',
      '[aria-live="assertive"]',
      ".zm-caption-view",
      "[id*='caption']",
    ];

    function tryAttach(): boolean {
      for (const sel of CAPTION_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) {
          attachObserver(el);
          return true;
        }
      }
      return false;
    }

    if (!tryAttach()) {
      // Retry when the caption panel appears
      const watcher = new MutationObserver(() => {
        if (tryAttach()) watcher.disconnect();
      });
      watcher.observe(document.body, { childList: true, subtree: true });
    }

    function attachObserver(container: Element) {
      let lastSent = "";

      const observer = new MutationObserver(() => {
        const lines = Array.from(container.querySelectorAll("[class*='caption'], span, p"))
          .map((el) => el.textContent?.trim() ?? "")
          .filter(Boolean);

        const text = lines.length > 0 ? lines.join(" ") : container.textContent?.trim() ?? "";

        if (text && text !== lastSent && text.length > 3) {
          lastSent = text;
          (window as any).hawkOnCaption(text);
        }
      });

      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  });

  if (verbose) console.log("[Zoom] Caption observer active — waiting for host captions");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeZoomUrl(url: string): string {
  // Already a web client URL
  if (url.includes("/wc/")) return url;

  // Extract meeting ID and password
  const meetingIdMatch = url.match(/\/j\/(\d+)/) || url.match(/\/w\/(\d+)/);
  if (!meetingIdMatch) return url;

  const meetingId = meetingIdMatch[1];
  const pwdMatch = url.match(/[?&]pwd=([^&]+)/);
  const pwd = pwdMatch ? `?pwd=${pwdMatch[1]}` : "";

  return `https://zoom.us/wc/${meetingId}/join${pwd}`;
}
