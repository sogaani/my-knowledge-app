import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export const errMsg = (e: unknown) => String((e as Error)?.message ?? e);

/**
 * Wraps an async UI action so it cannot run twice at once.
 * The ref guard is synchronous, so a double click or repeated Enter before React re-renders is dropped too.
 * Errors become an error toast; `success` (if given) becomes a success toast. Resolves to undefined on failure or when skipped.
 */
export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { success?: string | ((r: R) => string) } = {},
) {
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const latest = useRef({ fn, opts });
  latest.current = { fn, opts };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    if (busy.current) return undefined;
    busy.current = true; setPending(true);
    try {
      const r = await latest.current.fn(...args);
      const s = latest.current.opts.success;
      if (s) toast.success(typeof s === "function" ? s(r) : s);
      return r;
    } catch (e) {
      toast.error(errMsg(e));
      return undefined;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  return { run, pending };
}
