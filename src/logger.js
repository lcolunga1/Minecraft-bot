import fs from "fs";
import path from "path";

export function createLogger() {
  const LOG_DIR = process.env.LOG_DIR || "./logs";
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const file = path.join(LOG_DIR, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);

  function log(event) {
    const line = JSON.stringify({ ts: Date.now(), ...event }) + "\n";
    fs.appendFileSync(file, line, "utf8");
  }

  return { log, file };
}