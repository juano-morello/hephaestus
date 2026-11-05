import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api.ts";

export type PollOptions<T> = {
  fastMs: number;
  slowMs: number;
  fast: (v: T | undefined) => boolean;
};

/** Polls `fn`: every fastMs while `fast(data)`, else slowMs. Idle while the tab is hidden. */
export function usePoll<T>(
  fn: () => Promise<T>,
  o: PollOptions<T>,
): { data?: T; error?: ApiError; loading: boolean } {
  const [state, set] = useState<{ data?: T; error?: ApiError; loading: boolean }>({
    loading: true,
  });
  const latest = useRef({ fn, o });
  latest.current = { fn, o };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let data: T | undefined;
    let busy = false;

    const schedule = () => {
      if (stopped || document.hidden) return;
      const { fastMs, slowMs, fast } = latest.current.o;
      timer = setTimeout(tick, fast(data) ? fastMs : slowMs);
    };
    const tick = async () => {
      timer = undefined;
      if (stopped || document.hidden || busy) return;
      busy = true;
      try {
        data = await latest.current.fn();
        if (!stopped) set({ data, loading: false });
      } catch (e) {
        const error = e instanceof ApiError ? e : new ApiError("daemon", String(e));
        if (!stopped) set((s) => ({ ...s, error, loading: false }));
      }
      busy = false;
      schedule();
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      } else if (timer === undefined && !busy) {
        void tick();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  return state;
}
