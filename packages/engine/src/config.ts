import { createHash } from "node:crypto";
import type { Complexity, ContextPack, TaskKind } from "@hephaestus/core";

export type Route = { model: string; effort?: string };

export type EngineConfig = {
  /** role -> tier -> model and effort (SPEC section 10); `default` covers missing tiers. */
  routing: Record<string, Partial<Record<Complexity | "default", Route>>>;
  maxAttempts: number;
  budgetTokens: number;
  tools: string[];
  /** Per project: shown to the worker in the context pack and run by the command gates. */
  commands: Record<string, ContextPack["project"]["commands"]>;
  /** Per command gate run. Default 10 minutes. */
  gateTimeoutMs?: number;
  /** Units run at once. 1 runs the plan serially. */
  parallel: number;
};

export const ROLE_BY_KIND: Record<TaskKind, string> = {
  test: "test_author",
  implement: "implementer",
  codegen: "implementer",
  migration: "implementer",
  docs: "documenter",
};

export function resolveRoute(config: EngineConfig, role: string, tier: Complexity): Route {
  const route = config.routing[role]?.[tier] ?? config.routing[role]?.default;
  if (!route) throw new Error(`no route for role ${role} at tier ${tier}`);
  return route;
}

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
