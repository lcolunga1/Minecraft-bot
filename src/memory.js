import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/shared_memory.json");

function ensureFile() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ world: {}, players: {}, bases: [] }, null, 2));
}

export class SharedMemory {
  constructor() {
    ensureFile();
    this.mem = JSON.parse(fs.readFileSync(FILE, "utf8"));
    this.dirty = false;

    // autosave
    setInterval(() => {
      if (this.dirty) this.save();
    }, 2000).unref();
  }

  save() {
    ensureFile();
    fs.writeFileSync(FILE, JSON.stringify(this.mem, null, 2));
    this.dirty = false;
  }

  get() { return this.mem; }

  patch(patchObj) {
    // merge superficial seguro (simple)
    const merge = (a, b) => {
      for (const k of Object.keys(b || {})) {
        if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) {
          a[k] ??= {};
          merge(a[k], b[k]);
        } else {
          a[k] = b[k];
        }
      }
    };
    merge(this.mem, patchObj);
    this.dirty = true;
    return this.mem;
  }

  pushBase(base) {
    this.mem.bases ??= [];
    this.mem.bases.push(base);
    this.dirty = true;
  }
}