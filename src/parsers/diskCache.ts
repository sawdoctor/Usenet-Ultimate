import * as fs from 'node:fs';
import * as path from 'node:path';
import NodeCache from 'node-cache';

interface Snapshot {
  version: number;
  entries: Array<[key: string, value: unknown, expiresAtMs: number]>;
}

export interface DiskCacheOptions {
  schemaVersion: number;
  maxEntries: number;
  saveDelayMs: number;
}

const instances = new Set<DiskCache<unknown>>();

/** Writes every disk-backed cache now. Called on shutdown so a deploy keeps what was cached. */
export function saveAllDiskCaches(): void {
  for (const cache of instances) cache.saveNow();
}

/** A NodeCache whose entries survive a restart: loaded from `file` at start, saved a moment after each change. */
export class DiskCache<T> {
  private readonly cache = new NodeCache({ stdTTL: 0 });
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly file: string, private readonly options: DiskCacheOptions, now = Date.now()) {
    this.load(now);
    instances.add(this as DiskCache<unknown>);
  }

  get(key: string): T | undefined {
    return this.cache.get<T>(key);
  }

  set(key: string, value: T, ttlSeconds: number): void {
    this.cache.set(key, value, ttlSeconds);
    this.scheduleSave();
  }

  del(key: string): number {
    const removed = this.cache.del(key);
    if (removed > 0) this.scheduleSave();
    return removed;
  }

  flushAll(): void {
    this.cache.flushAll();
    this.scheduleSave();
  }

  saveNow(now = Date.now()): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const live: Snapshot['entries'] = [];
    for (const key of this.cache.keys()) {
      const expiresAt = this.cache.getTtl(key) ?? 0;
      if (expiresAt > now) live.push([key, this.cache.get(key), expiresAt]);
    }
    live.sort((a, b) => b[2] - a[2]);
    const snapshot: Snapshot = { version: this.options.schemaVersion, entries: live.slice(0, this.options.maxEntries) };
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`⚠️  Could not save ${path.basename(this.file)}: ${(err as Error).message}`);
    }
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.saveNow(), this.options.saveDelayMs);
    this.timer.unref();
  }

  private load(now: number): void {
    try {
      const snapshot = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Snapshot;
      if (snapshot.version !== this.options.schemaVersion) return;
      for (const [key, value, expiresAt] of snapshot.entries) {
        if (expiresAt > now) this.cache.set(key, value as T, (expiresAt - now) / 1000);
      }
    } catch {
      return;
    }
  }
}
