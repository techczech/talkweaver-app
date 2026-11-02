/** Main-process budget: cancellation drops queued work, never releases an active permit. */
export function createGalleryAdmission(limit = 2, capacity = 16) {
  type Job = { sender: number; generation: object; load(current:()=>boolean): Promise<unknown>; resolve(value: unknown): void; reject(reason: unknown): void };
  const queue: Job[] = [];
  const running = new Set<Job>();
  let active = 0;
  const generations = new Map<number, object>();
  const generation = (sender: number) => generations.get(sender);
  function drain() {
    while (active < limit && queue.length) {
      const job = queue.shift()!;
      active++;
      running.add(job);
      const current = () => job.generation === generation(job.sender);
      void Promise.resolve()
        .then(() => current() ? job.load(current) : null)
        .then(
          value => job.resolve(current() ? value : null),
          error => current() ? job.reject(error) : job.resolve(null)
        ).finally(() => {
        active--; running.delete(job);
        if (!queue.some(other => other.sender === job.sender) && ![...running].some(other => other.sender === job.sender)) generations.delete(job.sender);
        drain();
      });
    }
  }
  return {
    pending: () => queue.length,
    invalidate() {
      for (const sender of [...generations.keys()]) this.cancel(sender);
    },
    cancel(sender: number) {
      generations.delete(sender);
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].sender === sender) queue.splice(i, 1)[0].resolve(null);
    },
    run<T>(sender: number, load: (current:()=>boolean) => Promise<T>): Promise<T | null> {
      if (queue.length >= capacity) return Promise.resolve(null);
      return new Promise<T | null>((resolve, reject) => {
        if (!generations.has(sender)) generations.set(sender, {});
        queue.push({ sender, generation: generation(sender)!, load, resolve: value => resolve(value as T | null), reject }); drain();
      });
    }
  };
}
