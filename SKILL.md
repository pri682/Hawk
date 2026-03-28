---
name: hawk
description: AI event attendee that joins live YouTube streams, X Spaces, and Zoom webinars on your behalf — capturing captions and live chat in real time.
homepage: https://github.com/pri682/hawk
metadata: { "openclaw": { "emoji": "🦅", "requires": { "bins": ["node"] } } }
---

# Hawk

## STOP — Ask the user before doing anything

**When the user asks to join a stream or event, do these steps IN ORDER. Do NOT skip ahead.**

**Step A:** Read the file `~/.hawk/auth-meta.json` (it may not exist — that's fine).

**Step B:** Identify the platform from the URL:
- `youtube.com` or `youtu.be` → **YouTube Live** (no auth needed for public streams)
- `twitter.com/i/spaces` or `x.com/i/spaces` → **X Spaces** (may need auth for private Spaces)
- `zoom.us` → **Zoom Webinar** (may need auth for private webinars)

**Step C:** Ask the user:

For YouTube (public):
> "I'll join the stream anonymously (no login needed). Want me to watch for any specific keywords? For example: 'pricing', 'roadmap', 'Q&A'."

For X Spaces or Zoom (if auth-meta.json exists):
> "How would you like me to join?
> 1. As **user@email.com** (authenticated)
> 2. Anonymously (no login)"

For X Spaces or Zoom (if auth-meta.json does NOT exist):
> "This may work anonymously. Want me to try joining without auth first? If it fails, we can run `hawk auth` to save your session."

**Step D:** WAIT for the user to answer. Only then launch the bot.

---

Hawk is your AI stand-in for live events. It joins streams on your behalf, captures what speakers say (captions) and what the audience says (live chat), and lets you check in anytime: "what are they talking about?", "did they mention pricing?", "send me a screenshot."

## Prerequisites

- `playwright-core` (ships with openclaw)
- Chromium: `npx playwright-core install chromium`

## Join a Stream

**IMPORTANT: Always run join commands with `background:true`** — the bot stays live for the duration of the stream. Never wait for it to complete.

### YouTube Live

```bash
exec background:true command:"npx hawk join https://youtube.com/watch?v=<id> --channel <current-channel> --target <current-chat-id>"
```

With keyword alerts:
```bash
exec background:true command:"npx hawk join https://youtube.com/watch?v=<id> --keyword pricing --keyword roadmap --channel <current-channel> --target <current-chat-id>"
```

### X Spaces

```bash
exec background:true command:"npx hawk join https://x.com/i/spaces/<id> --channel <current-channel> --target <current-chat-id>"
```

With saved auth:
```bash
exec background:true command:"npx hawk join https://x.com/i/spaces/<id> --auth --channel <current-channel> --target <current-chat-id>"
```

### Zoom Webinar

```bash
exec background:true command:"npx hawk join https://zoom.us/j/<id> --channel <current-channel> --target <current-chat-id>"
```

**IMPORTANT:** Always pass `--channel` and `--target` from the current conversation context.

Other join options:
- `--headed` — show the browser (for debugging)
- `--duration 90m` — auto-leave after duration (supports ms/s/m/h)
- `--keyword <word>` — alert when word is mentioned (repeat for multiple)
- `--verbose` — print live activity to stdout
- `--auth` — use saved session from `~/.hawk/auth.json`

## What Hawk Captures

Hawk captures two parallel streams into the same transcript file:

```
[14:30:05] 🎙️  And now let's talk about our Q3 roadmap...
[14:30:08] 💬 viewer123: excited for this!!
[14:30:09] 💬 techguy99: been waiting for roadmap news
[14:30:12] 🎙️  We're launching three major features this quarter...
[14:30:15] 💰 superfan: $5.00 — love your work!
```

- `🎙️` = captions (what speakers/hosts are saying)
- `💬` = live chat (what the audience is saying)
- `💰` = super chats / donations (YouTube)

## Get Transcript (what are they saying?)

**When the user asks "what's happening?", "what did they say about X?", "summarize so far" — run this.**

```bash
exec command:"npx hawk transcript"
```

Use `--last 30` for recent lines only (long streams):
```bash
exec command:"npx hawk transcript --last 30"
```

Read the output and give the user a natural language summary. Separate what speakers said from what the chat was saying.

## Take a Screenshot

If the user asks to **see** the stream ("send me a screenshot", "what does it look like"):

```bash
exec command:"npx hawk screenshot"
```

Then send the screenshot image to the user:
```
message action:"send" media:"./hawk/on-demand-screenshot.png" content:"Here's the current stream view"
```

**ALWAYS use `media:` to send the actual image. Never just describe it in text.**

## How It Works

1. **Join**: Launches headless Chromium, navigates to the stream URL. No host admission needed — Hawk is a viewer.
2. **Captions**: Enables auto-generated captions (YouTube CC button, X Spaces transcript panel, Zoom CC) and hooks a MutationObserver to capture text as it appears.
3. **Live chat** (YouTube): Hooks into the chat iframe MutationObserver to capture viewer messages in real time.
4. **Transcript**: Both streams write to a single timestamped file under `~/.openclaw/workspace/hawk/transcripts/`.
5. **Keywords**: If `--keyword` was passed, Hawk prints `[HAWK_KEYWORD]` markers to stdout when the word appears in captions or chat.

## Keyword Alerts

When the user says "tell me when they mention pricing":

1. Stop any running session and restart with `--keyword pricing`
2. Poll the process output for `[HAWK_KEYWORD]` lines
3. When seen, immediately notify the user

Or if starting fresh:
```bash
exec background:true command:"npx hawk join <url> --keyword pricing --channel <ch> --target <id>"
```

## Agent Behavior — MANDATORY

After launching with `exec background:true`, you MUST poll and send images back.

### Step 1: Poll after launch

```
process action:poll
```

### Step 2: Parse markers and send images

**On success** — bot prints `[HAWK_SUCCESS_IMAGE] <path>`:
```
message action:"send" media:"./hawk/joined-stream.png" content:"I've joined the stream! I'll capture everything. Ask me what's happening anytime."
```

**On screenshot request** — bot prints `[HAWK_SCREENSHOT] <path>`:
```
message action:"send" media:"./hawk/on-demand-screenshot.png" content:"Here's what the stream looks like right now"
```

**On failure** — bot prints `[HAWK_DEBUG_IMAGE] <path>` or exits non-zero:
```
message action:"send" media:"./hawk/debug-join-failed.png" content:"I couldn't join the stream. Here's what I saw."
```

**On keyword hit** — bot prints `[HAWK_KEYWORD] "pricing" mentioned: ...`:
```
message action:"send" content:"🚨 Keyword alert: they just mentioned 'pricing' — [quote the exact text]"
```

**On stream end** — bot prints `[HAWK_TRANSCRIPT] <path>`:
Run `npx hawk transcript` and send the user a full summary.

### When to use which command

| User asks...                               | Use this                  |
|--------------------------------------------|---------------------------|
| "what are they saying?"                    | `hawk transcript`         |
| "what's happening?"                        | `hawk transcript`         |
| "summarize the stream"                     | `hawk transcript`         |
| "did they mention X?"                      | `hawk transcript` + search|
| "send me a screenshot"                     | `hawk screenshot`         |
| "what does it look like?"                  | `hawk screenshot`         |

## Auth (Optional — for private streams)

To save a session for private X Spaces or Zoom:

```bash
exec command:"npx hawk auth x"
exec command:"npx hawk auth zoom"
```

This opens a headed browser. Sign in, press Enter. Session saved to `~/.hawk/auth.json`.
Then join with `--auth` flag.

## Files

- `~/.hawk/auth.json` — saved browser session
- `~/.hawk/auth-meta.json` — login metadata (platform, email, timestamp)
- `~/.openclaw/workspace/hawk/transcripts/` — all transcripts
- `~/.openclaw/workspace/hawk/hawk.pid` — PID of the running session
- `~/.openclaw/workspace/hawk/on-demand-screenshot.png` — latest screenshot
- `~/.openclaw/workspace/hawk/joined-stream.png` — confirmation screenshot on join
- `~/.openclaw/workspace/hawk/debug-join-failed.png` — screenshot on join failure

## Transcript Format

```
~/.openclaw/workspace/hawk/transcripts/<stream-id>-<YYYY-MM-DD>.txt
```

Example:
```
[14:30:05] 🎙️  Welcome everyone to the live stream
[14:30:08] 💬 viewer1: hype!!
[14:30:12] 🎙️  Today we're covering the Q3 product roadmap
```

## Troubleshooting

- **YouTube captions empty**: Try `--headed --verbose`. The CC button selector may have changed with a YouTube UI update.
- **X Spaces no captions**: X caption selectors shift with UI changes. Try `--headed` to verify the transcript panel is visible.
- **Zoom join prompt**: Some webinars require a password. Include `?pwd=...` in the URL.
- **Headless detection**: Hawk uses stealth patches. If a platform blocks it, try `--headed` for debugging.
- **Chromium missing**: Run `npx playwright-core install chromium`.
