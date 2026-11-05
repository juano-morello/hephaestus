/** Runs `fn` while holding `repo`'s lock. */
export type JoinLock = <T>(repo: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Per-repo mutexes for joining accepted attempts onto the run branch (design 4.3): functions
 * for one repo run one at a time, in call order; other repos are not held up. A function that
 * throws releases the lock like one that returns.
 */
export function joinLocks(): JoinLock {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(repo: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(repo) ?? Promise.resolve();
    // `prev` never rejects: tails only ever hold settled-to-undefined promises.
    const next = prev.then(() => fn());
    const tail = next.catch(() => {});
    tails.set(repo, tail);
    void tail.then(() => {
      if (tails.get(repo) === tail) tails.delete(repo);
    });
    return next;
  };
}
