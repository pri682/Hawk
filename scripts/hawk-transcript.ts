import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const lastIdx = args.indexOf("--last");
const lastN = lastIdx >= 0 ? parseInt(args[lastIdx + 1]) : null;

const transcriptDir = join(homedir(), ".openclaw", "workspace", "hawk", "transcripts");

if (!existsSync(transcriptDir)) {
  console.error("No transcripts found. Has Hawk joined a stream yet?");
  process.exit(1);
}

// Find the most recently modified transcript file
const files = readdirSync(transcriptDir)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => ({
    name: f,
    path: join(transcriptDir, f),
    mtime: existsSync(join(transcriptDir, f))
      ? new Date(readFileSync(join(transcriptDir, f)).length > 0
          ? // use file name date as secondary sort
            f.replace(/^.*-(\d{4}-\d{2}-\d{2})\.txt$/, "$1") || "1970-01-01"
          : "1970-01-01")
      : new Date(0),
  }))
  .sort((a, b) => b.name.localeCompare(a.name));

if (files.length === 0) {
  console.error("No transcript files found in", transcriptDir);
  process.exit(1);
}

const latest = files[0];
const content = readFileSync(latest.path, "utf8");
const lines = content.split("\n").filter(Boolean);

if (lines.length === 0) {
  console.log(`Transcript is empty: ${latest.path}`);
  process.exit(0);
}

const output = lastN ? lines.slice(-lastN) : lines;
console.log(output.join("\n"));
