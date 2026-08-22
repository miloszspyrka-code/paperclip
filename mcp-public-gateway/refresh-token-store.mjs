import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class RefreshTokenStore {
  constructor({ file, ttlMs, now = () => Date.now() }) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.now = now;
    this.tokens = this.load();
    this.prune();
  }

  load() {
    if (!existsSync(this.file)) return new Map();
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return new Map(Object.entries(parsed.tokens || {}));
    } catch {
      return new Map();
    }
  }

  expired(record) {
    return !record || record.createdAt + this.ttlMs <= this.now();
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify({ version: 1, tokens: Object.fromEntries(this.tokens) });
    writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
    chmodSync(this.file, 0o600);
  }

  prune() {
    let changed = false;
    for (const [token, record] of this.tokens) {
      if (this.expired(record)) {
        this.tokens.delete(token);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  issue(token, record) {
    this.prune();
    this.tokens.set(token, { ...record, createdAt: this.now() });
    this.save();
  }

  get(token) {
    const record = this.tokens.get(token);
    if (this.expired(record)) {
      if (record) {
        this.tokens.delete(token);
        this.save();
      }
      return null;
    }
    return record;
  }

  rotate(previousToken, nextToken) {
    const record = this.get(previousToken);
    if (!record) return null;
    this.tokens.delete(previousToken);
    this.tokens.set(nextToken, { ...record, createdAt: this.now() });
    this.save();
    return record;
  }

  revoke(token) {
    if (!this.tokens.delete(token)) return;
    this.save();
  }

  close() {
    // The store writes synchronously on each lifecycle transition.
  }
}
