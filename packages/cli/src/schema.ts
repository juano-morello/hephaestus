import { Brief, HomeConfigLayer, RepoConfigLayer, WorkspaceConfig } from "@hephaestus/core";
import { z } from "zod";

export const SCHEMA_NAMES = ["home", "workspace", "repo", "brief"] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

export const isSchemaName = (s: string): s is SchemaName =>
  (SCHEMA_NAMES as readonly string[]).includes(s);

const SOURCES = {
  home: HomeConfigLayer,
  workspace: WorkspaceConfig,
  repo: RepoConfigLayer,
  brief: Brief,
} as const;

/** The JSON Schema of a config file or the Brief, generated from the zod definition. */
export function schemaFor(name: SchemaName): Record<string, unknown> {
  return z.toJSONSchema(SOURCES[name]) as Record<string, unknown>;
}
