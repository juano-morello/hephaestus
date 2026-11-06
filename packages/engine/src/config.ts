import { createHash } from "node:crypto";
import {
  type Complexity,
  type ContextPack,
  RUNGS,
  type Rung,
  type TaskKind,
} from "@hephaestus/core";

export type Route = { model: string; effort?: string };

export type EngineConfig = {
  /**
   * role -> rung -> model and effort (SPEC section 10); `default` covers missing tiers. `top` is
   * the ladder's optional last rung; `fallback` an optional route on another provider.
   */
  routing: Record<string, Partial<Record<Rung | "default" | "fallback", Route>>>;
  maxAttempts: number;
  budgetTokens: number;
  tools: string[];
  /** Per project: shown to the worker in the context pack and run by the command gates. */
  commands: Record<string, ContextPack["project"]["commands"]>;
  /** Per command gate run. Default 10 minutes. */
  gateTimeoutMs?: number;
  /** Wall-clock limit per worker attempt, and per tier. Default 20 minutes. */
  attemptTimeoutMs?: number;
  attemptTimeoutByTier?: Partial<Record<Complexity, number>>;
  /** Abort an attempt with no model output and no tool running for this long. Default 10 minutes. */
  idleTimeoutMs?: number;
  /** Re-runs of a worker that returned nothing; they do not use one of maxAttempts. Default 2. */
  transportRetries?: number;
  /** Units run at once. 1 runs the plan serially; the configured default is 3. */
  parallel: number;
};

export const ROLE_BY_KIND: Record<TaskKind, string> = {
  test: "test_author",
  implement: "implementer",
  codegen: "implementer",
  migration: "implementer",
  docs: "documenter",
};

/** The route for a rung: `top` falls back to the role's `complex` route, any tier to `default`. */
export function resolveRoute(config: EngineConfig, role: string, rung: Rung): Route {
  const routes = config.routing[role];
  if (rung === "top" && routes?.top) return routes.top;
  const tier: Complexity = rung === "top" ? "complex" : rung;
  const route = routes?.[tier] ?? routes?.default;
  if (!route) throw new Error(`no route for role ${role} at tier ${rung}`);
  return route;
}

/** The role's route on another provider, for when the ladder's provider is rate limited. */
export function fallbackRoute(config: EngineConfig, role: string): Route | undefined {
  return config.routing[role]?.fallback;
}

/**
 * The ladder (routing design 2): the start tier plus one rung per red attempt, capped at `top`,
 * or at `complex` for a role without a `top` route.
 */
export function rungFor(start: Complexity, reds: number, hasTop: boolean): Rung {
  const cap = RUNGS.indexOf(hasTop ? "top" : "complex");
  return RUNGS[Math.min(RUNGS.indexOf(start) + reds, cap)] as Rung;
}

/** How long a provider cools after a rate limit that gave no `retry_after`. */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** "claude/sonnet" -> "claude". */
export const providerOf = (model: string) => model.split("/")[0] || model;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** Recorded on every event, so the retro can tell config changes from model drift. */
export function configHash(config: EngineConfig, gateNames: string[]): string {
  const json = JSON.stringify(canonical({ ...config, roles: ROLE_BY_KIND, gates: gateNames }));
  return createHash("sha256").update(json).digest("hex");
}
