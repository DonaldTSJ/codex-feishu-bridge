import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PATH = join(homedir(), ".codex-feishu-bridge", "sessions.json");

export class SessionStore {
  constructor(path = DEFAULT_PATH) {
    this.path = path;
    this.data = {};
    this.saving = Promise.resolve();
  }

  async load() {
    try {
      const text = await readFile(this.path, "utf8");
      const raw = JSON.parse(text);
      this.data = {};
      for (const [scope, entry] of Object.entries(raw)) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.sessionId !== "string") continue;
        this.data[scope] = {
          sessionId: entry.sessionId,
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now()
        };
      }
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
  }

  get(scope) {
    return this.data[scope]?.sessionId;
  }

  set(scope, sessionId) {
    this.data[scope] = { sessionId, updatedAt: Date.now() };
    this.scheduleSave();
  }

  clear(scope) {
    if (!(scope in this.data)) return false;
    delete this.data[scope];
    this.scheduleSave();
    return true;
  }

  async flush() {
    await this.saving;
  }

  scheduleSave() {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp-${process.pid}`;
        await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
        await rename(tmp, this.path);
      })
      .catch((err) => {
        console.error("[sessions] save failed:", err?.message ?? String(err));
      });
  }
}
