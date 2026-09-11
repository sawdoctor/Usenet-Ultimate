/**
 * Coalesce concurrent work for the same key.
 *
 * This intentionally does not cache completed results. Callers own their
 * normal caches and use SingleFlight to close the gap before those caches are
 * populated.
 */
export class SingleFlight<K, V> {
  private readonly inflight = new Map<K, Promise<V>>();

  run(key: K, task: () => Promise<V>, onJoin?: () => void): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) {
      onJoin?.();
      return existing;
    }

    const pending = Promise.resolve().then(task);
    this.inflight.set(key, pending);
    pending.finally(() => {
      // Do not let an older completion delete newer work for the same key.
      if (this.inflight.get(key) === pending) this.inflight.delete(key);
    }).catch(() => {
      // The promise returned to the caller retains the rejection; this catch
      // only handles the promise created by finally().
    });
    return pending;
  }
}
