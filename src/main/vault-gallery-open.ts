/** Registry generation is checked on both sides of the deferred catalogue read.
 * The synchronous claim callback is the existing window ownership policy. */
export function createGalleryClaim<T extends {
  outlinePath: string;
}>(deps: {
  epoch(): number;
  resolve(id: unknown, path: unknown, epoch: unknown): Promise<T | null>;
  claim(senderId: number, path: string): {
    ok: boolean;
    reason?: string;
  };
}) {
  return async (senderId: number, id: unknown, path: unknown, epoch: unknown) => {
    if (!Number.isSafeInteger(epoch) || epoch !== deps.epoch())
      return { ok: false, reason: 'stale' };
    const talk = await deps.resolve(id, path, epoch);
    if (!talk || epoch !== deps.epoch())
      return { ok: false, reason: 'stale' };
    return deps.claim(senderId, talk.outlinePath);
  };
}
