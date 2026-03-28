import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const pidPath = join(homedir(), ".openclaw", "workspace", "hawk", "hawk.pid");

if (!existsSync(pidPath)) {
  console.error("No running Hawk session found (no PID file). Start one with: hawk join <url>");
  process.exit(1);
}

const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
if (isNaN(pid)) {
  console.error("Invalid PID in hawk.pid");
  process.exit(1);
}

try {
  process.kill(pid, "SIGUSR1");
  console.log(`Screenshot requested from Hawk process (PID ${pid})`);
  console.log("Screenshot will be saved to:");
  console.log(join(homedir(), ".openclaw", "workspace", "hawk", "on-demand-screenshot.png"));
} catch (e: any) {
  if (e.code === "ESRCH") {
    console.error(`Hawk process ${pid} is not running. Session may have ended.`);
    process.exit(1);
  }
  throw e;
}
