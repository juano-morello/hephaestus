import { mountRun } from "./run.ts";

// The CLI package has no DOM lib; this file only ever runs in the host's iframe.
declare const window: unknown;
declare const document: unknown;
declare const setInterval: (fn: () => void, ms: number) => unknown;
declare const clearInterval: (h: unknown) => void;
declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const clearTimeout: (h: unknown) => void;
mountRun(window as never, document as never, {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
});
