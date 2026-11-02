export interface GalleryOpenGuard<T> {
  settle?(commit: boolean): Promise<{ok:boolean}>;
  isCurrent(): boolean;
  revalidate(): Promise<T | null>;
  claim(path: string | null): Promise<{ok: boolean; reason?: string}>;
}

/** The editor owns leaving; main owns the window claim. Adoption happens only after both. */
export async function selectGuardedTalk<T extends {
  outlinePath: string;
}>(talk: T | null, deps: {
  settle?(commit: boolean): Promise<{ok:boolean}>;
  isCurrent?(): boolean;
  revalidate?(): Promise<T | null>;
  current(): T | null;
  leave(): Promise<boolean>;
  claim(path: string | null): Promise<{
    ok: boolean;
  } | undefined>;
  adopt(talk: T | null): void;
  refused(talk: T): void;
}): Promise<boolean> {
  const previous = deps.current();
  if (previous && previous.outlinePath !== talk?.outlinePath && !await deps.leave())
    return false;
  if (deps.isCurrent?.() === false)
    return false;
  if (talk && deps.revalidate) {
    const current = await deps.revalidate();
    if (!current || current.outlinePath !== talk.outlinePath || deps.isCurrent?.() === false)
      return false;
    talk = current;
  }
  try {
  const claim = await deps.claim(talk?.outlinePath ?? null);
  if (talk && claim?.ok === false) {
    deps.refused(talk);
    return false;
  }
  // The claim reply itself may have waited behind a registry change in IPC delivery.
  const confirmed = talk && deps.revalidate ? await deps.revalidate().catch(() => null) : talk;
  if (deps.isCurrent?.() === false || (talk && (!confirmed || confirmed.outlinePath !== talk.outlinePath))) {
    if (deps.settle) {
      if (!(await deps.settle(false)).ok) throw new Error('Outgoing talk ownership could not be restored');
    } else if (previous?.outlinePath !== talk?.outlinePath) {
      const restored = await deps.claim(previous?.outlinePath ?? null);
      if (restored?.ok === false) throw new Error('Outgoing talk ownership could not be restored');
    }
    return false;
  }
  if (deps.settle && !(await deps.settle(true)).ok) return false;
  deps.adopt(talk);
  return true;
  } catch (error) {
    if (deps.settle && !(await deps.settle(false)).ok) throw new Error('Outgoing talk ownership could not be restored');
    throw error;
  }
}

/** Main has already transferred this window's claim with its own filesystem mutation. */
export async function adoptMovedTalk<T extends {outlinePath:string}>(talk:T, from:string, deps:{
  current():T|null;
  confirm(from:string,to:string):Promise<{ok:boolean; destinationText?:string}>;
  adopt(talk:T):void;
  isCurrent?():boolean;
}):Promise<boolean> {
  const previous = deps.current();
  if (previous?.outlinePath !== from) return false;
  const confirmed = await deps.confirm(from,talk.outlinePath);
  if (!confirmed.ok) return false;
  if (deps.current() !== previous || deps.isCurrent?.() === false) return false;
  if (confirmed.destinationText !== undefined) window.dispatchEvent(new CustomEvent('tw-adopt-moved-buffer', {detail:{from,to:talk.outlinePath,diskText:confirmed.destinationText}}));
  deps.adopt(talk);
  return true;
}
