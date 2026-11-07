import { mountPlan } from "./plan.ts";

// The CLI package has no DOM lib; this file only ever runs in the host's iframe.
declare const window: unknown;
declare const document: unknown;
mountPlan(window as never, document as never);
