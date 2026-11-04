#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { explainConfig, type LoadedConfig, loadConfig } from "./config.ts";

/** Output schema version of every `--json` envelope (SPEC section 16). */
export const JSON_SCHEMA = 1;

export type Io = {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
};

type Flags = { json: boolean; workspace?: string; set: string[] };
type Ctx = Io & { flags: Flags; args: string[] };

type Command<T> = {
  run: (ctx: Ctx) => Promise<T>;
  /** Human output; `--json` prints `data` in the envelope instead. */
  render: (data: T) => string;
};

const command = <T>(c: Command<T>): Command<unknown> => c as Command<unknown>;

/** Command name (its words joined by a space) -> handler. Add commands here. */
const COMMANDS: Record<string, Command<unknown>> = {
  "config explain": command<LoadedConfig>({
    run: (ctx) =>
      loadConfig({
        workspaceDir: ctx.flags.workspace
          ? resolve(ctx.cwd, ctx.flags.workspace)
          : findWorkspace(ctx.cwd),
        home: ctx.env.HEPH_HOME || join(homedir(), ".heph"),
        overrides: parseSets(ctx.flags.set),
      }),
    render: (loaded) => `${explainConfig(loaded).join("\n")}\n`,
  }),
};

/** The nearest directory at or above `cwd` with `.heph/workspace.yaml`, else `cwd` itself. */
export function findWorkspace(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".heph", "workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

/** `--set key=value`; the value is parsed as YAML, so numbers and booleans keep their type. */
function parseSets(sets: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sets) {
    const eq = s.indexOf("=");
    if (eq <= 0) throw new Error(`--set expects key=value, got "${s}"`);
    const raw = s.slice(eq + 1);
    out[s.slice(0, eq)] = raw === "" ? "" : Bun.YAML.parse(raw);
  }
  return out;
}

function match(positionals: string[]): { name: string; args: string[] } | undefined {
  for (let n = positionals.length; n > 0; n--) {
    const name = positionals.slice(0, n).join(" ");
    if (COMMANDS[name]) return { name, args: positionals.slice(n) };
  }
  return undefined;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let json = argv.includes("--json");
  let name = argv.filter((a) => !a.startsWith("-")).join(" ");
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        workspace: { type: "string" },
        set: { type: "string", multiple: true, default: [] },
      },
    });
    json = values.json ?? false;
    const found = match(positionals);
    if (!found) {
      name = positionals.join(" ");
      throw new Error(`unknown command "${name}"; known: ${Object.keys(COMMANDS).join(", ")}`);
    }
    name = found.name;
    const cmd = COMMANDS[name] as Command<unknown>;
    const flags: Flags = {
      json,
      set: values.set ?? [],
      ...(values.workspace ? { workspace: values.workspace } : {}),
    };
    const data = await cmd.run({ ...io, flags, args: found.args });
    if (json) {
      io.stdout(`${JSON.stringify({ schema: JSON_SCHEMA, command: name, ok: true, data })}\n`);
    } else {
      io.stdout(cmd.render(data));
    }
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (json) {
      io.stdout(
        `${JSON.stringify({ schema: JSON_SCHEMA, command: name, ok: false, error: { message } })}\n`,
      );
    } else {
      io.stderr(`heph: ${message}\n`);
    }
    return 1;
  }
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(code);
}
