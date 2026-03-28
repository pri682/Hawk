import type { Page } from "playwright-core";

interface XSpacesOptions {
  verbose?: boolean;
}

/**
 * X (Twitter) Spaces: join a Space and capture auto-generated captions.
 * Calls window.hawkOnCaption(text) exposed from hawk-join.ts.
 *
 * X Spaces auto-captions appear in a transcript panel at the bottom of the player.
 * Selector targets the live transcript text that updates as speakers talk.
 */
export async function setupXSpaces(page: Page, url: string, opts: XSpacesOptions): Promise<void> {
  const { verbose } = opts;

  // Normalize URL — x.com and twitter.com both work
  const normalizedUrl = url.replace("twitter.com", "x.com");

  await page.goto(normalizedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Dismiss cookie/login prompts
  try {
    // "Not now" or "Close" on login modal
    const closeBtn = page
      .locator('[data-testid="xMigrationBottomBar"] button, [role="dialog"] [aria-label="Close"]')
      .first();
    await closeBtn.click({ timeout: 4_000 });
    if (verbose) console.log("[X Spaces] Dismissed login prompt");
  } catch {}

  // Wait for the Space player to load
  // X Spaces player loads the audio card / space card
  try {
    await page.waitForSelector(
      '[data-testid="audioSpaceCard"], [data-testid="spaces-join-button"], [aria-label*="Space"]',
      { timeout: 20_000 }
    );
    if (verbose) console.log("[X Spaces] Space player found");
  } catch {
    if (verbose) console.log("[X Spaces] Could not find Space player — may require auth or Space has ended");
  }

  // Click the "Listen" / "Join" button if present
  try {
    const listenBtn = page.locator(
      '[data-testid="spaces-join-button"], button:has-text("Listen"), button:has-text("Join")'
    ).first();
    await listenBtn.click({ timeout: 5_000 });
    if (verbose) console.log("[X Spaces] Clicked listen/join button");
    await page.waitForTimeout(2_000);
  } catch {}

  // Enable captions if a toggle is visible
  try {
    const captionToggle = page.locator(
      '[aria-label*="caption" i], [aria-label*="transcript" i], button:has-text("CC")'
    ).first();
    await captionToggle.click({ timeout: 5_000 });
    if (verbose) console.log("[X Spaces] Enabled captions");
    await page.waitForTimeout(1_000);
  } catch {}

  // ── Caption MutationObserver ──────────────────────────────────────────────
  // X Spaces renders live captions in a transcript panel.
  // The exact selector may shift with X UI updates — we try multiple and fall back to text scanning.
  await page.evaluate(() => {
    const CAPTION_SELECTORS = [
      '[data-testid="audioSpacesTranscript"]',
      '[data-testid="spaces-transcript-text"]',
      ".css-1dbjc4n[aria-live]",
      '[aria-live="polite"]',
      '[aria-live="assertive"]',
    ];

    let captionContainer: Element | null = null;
    for (const sel of CAPTION_SELECTORS) {
      captionContainer = document.querySelector(sel);
      if (captionContainer) break;
    }

    if (!captionContainer) {
      // Fallback: watch for any aria-live region that appears
      const bodyObserver = new MutationObserver(() => {
        for (const sel of CAPTION_SELECTORS) {
          const el = document.querySelector(sel);
          if (el) {
            bodyObserver.disconnect();
            attachObserver(el);
            return;
          }
        }
        // Also scan for aria-live regions added dynamically
        const live = document.querySelector('[aria-live="polite"], [aria-live="assertive"]');
        if (live) {
          bodyObserver.disconnect();
          attachObserver(live);
        }
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
      return;
    }

    attachObserver(captionContainer);

    function attachObserver(container: Element) {
      let lastSent = "";

      const observer = new MutationObserver(() => {
        const text = container.textContent?.trim() ?? "";
        if (text && text !== lastSent && text.length > 3) {
          lastSent = text;
          // X Spaces captions include speaker names in some formats — pass as-is
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

  if (verbose) console.log("[X Spaces] Caption observer active — waiting for speakers");

  // ── Space ended detection ─────────────────────────────────────────────────
  // We don't set up a poll here — hawk-join.ts handles the heartbeat for YouTube.
  // For X Spaces, the page will navigate or show an ended state.
  // Future: watch for [data-testid="audioSpaceEndedCard"] etc.
}
