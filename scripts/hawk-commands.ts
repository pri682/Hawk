/**
 * hawk-commands.ts
 * Processes @hawk chat commands and returns plain-text replies.
 * Used by all platform modules — no platform-specific logic here.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const transcriptDir = join(homedir(), ".openclaw", "workspace", "hawk", "transcripts");

let startTime = Date.now();
let activeKeywords: string[] = [];

export function setStartTime(t: number) {
  startTime = t;
}

export function addKeyword(kw: string) {
  activeKeywords.push(kw.toLowerCase());
}

// ── Find latest transcript ────────────────────────────────────────────────────

function getLatestTranscriptLines(): string[] {
  if (!existsSync(transcriptDir)) return [];
  const files = readdirSync(transcriptDir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .reverse();
  if (files.length === 0) return [];
  const content = readFileSync(join(transcriptDir, files[0]), "utf8");
  return content.split("\n").filter(Boolean);
}

// ── Command parser ────────────────────────────────────────────────────────────

export function parseCommand(message: string): string | null {
  const lower = message.toLowerCase().trim();

  // Must start with @hawk or hawk
  if (!lower.startsWith("@hawk") && !lower.startsWith("hawk")) return null;

  // Extract the command part after "@hawk " or "hawk "
  const body = message.replace(/^@?hawk\s*/i, "").trim().toLowerCase();

  if (!body || body === "help") return handleHelp();
  if (body === "summary" || body === "what" || body === "whats happening" || body === "what's happening") return handleSummary();
  if (body === "status") return handleStatus();
  if (body.startsWith("keyword ")) return handleKeyword(body.replace("keyword ", "").trim());
  if (body === "keywords") return handleKeywordList();

  // Unknown command — show help
  return `🦅 Unknown command "${body}". Type @hawk help to see what I can do.`;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleHelp(): string {
  return [
    "🦅 Hawk commands:",
    "  @hawk summary         — what the speaker just said",
    "  @hawk status          — how long I've been watching",
    "  @hawk keyword <word>  — alert when word is mentioned",
    "  @hawk keywords        — list active keyword alerts",
    "  @hawk help            — show this list",
  ].join("\n");
}

function handleSummary(): string {
  const lines = getLatestTranscriptLines();
  if (lines.length === 0) return "🦅 Nothing captured yet — captions may not be enabled.";

  // Get last 5 caption lines (🎙️ only, skip chat lines)
  const captions = lines
    .filter((l) => l.includes("🎙️"))
    .slice(-5)
    .map((l) => l.replace(/^\[.*?\]\s*🎙️\s*/, "").trim())
    .filter(Boolean);

  if (captions.length === 0) return "🦅 No speech captured yet.";

  return `🦅 Last few things said:\n${captions.map((c) => `  "${c}"`).join("\n")}`;
}

function handleStatus(): string {
  const lines = getLatestTranscriptLines();
  const captionCount = lines.filter((l) => l.includes("🎙️")).length;
  const chatCount = lines.filter((l) => l.includes("💬")).length;
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  const kwStatus = activeKeywords.length > 0
    ? `\n  Watching for: ${activeKeywords.join(", ")}`
    : "";

  return [
    `🦅 Hawk status:`,
    `  Watching for: ${duration}`,
    `  Captions captured: ${captionCount}`,
    `  Chat messages seen: ${chatCount}`,
    kwStatus,
  ].filter(Boolean).join("\n");
}

function handleKeyword(word: string): string {
  if (!word) return "🦅 Usage: @hawk keyword <word>  e.g. @hawk keyword pricing";
  addKeyword(word);
  return `🦅 Got it — I'll alert in chat when "${word}" is mentioned.`;
}

function handleKeywordList(): string {
  if (activeKeywords.length === 0) return "🦅 No keywords set. Use: @hawk keyword <word>";
  return `🦅 Watching for: ${activeKeywords.join(", ")}`;
}

// ── Keyword check (called from hawk-join.ts on every caption/chat line) ───────

export function checkKeywordsAndReply(text: string): string | null {
  if (activeKeywords.length === 0) return null;
  const lower = text.toLowerCase();
  for (const kw of activeKeywords) {
    if (lower.includes(kw)) {
      return `🦅 Keyword alert — "${kw}" was just mentioned:\n  "${text.trim()}"`;
    }
  }
  return null;
}
