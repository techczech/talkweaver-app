/** At most two visible cards can prepare facts. Hidden waiting cards never reach main. */
export function createVisibleDemand<T>(load: (key: string) => Promise<T>, publish: (key: string, value: T) => void, limit = 2) {
  const visible = new Set<string>(), waiting = new Set<string>(), started = new Set<string>();
  const activeKeys = new Set<string>();
  let active = 0, disposed = false;
  const drain = () => {
    if (disposed)
      return;
    for (const key of waiting) {
      if (active >= limit)
        break;
      waiting.delete(key);
      if (!visible.has(key))
        continue;
      active++;
      activeKeys.add(key);
      started.add(key);
      void load(key).then(value => {
        if (!disposed)
          publish(key, value);
      }).catch(() => { }).finally(() => {
        active--;
        activeKeys.delete(key);
        if (visible.has(key) && !started.has(key)) waiting.add(key);
        drain();
      });
    }
  };
  return {
    isVisible(key: string) { return visible.has(key) && !disposed; },
    show(key: string) {
      visible.add(key); if (!started.has(key) && !activeKeys.has(key))
        waiting.add(key); drain();
    }, hide(key: string) { visible.delete(key); waiting.delete(key); started.delete(key); }, dispose() { disposed = true; visible.clear(); waiting.clear(); }
  };
}
