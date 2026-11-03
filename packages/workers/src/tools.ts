import { WorkerResult } from "@hephaestus/core";
import { resolveInside, type Sandbox } from "@hephaestus/sandbox";

export const TOOL_NAMES = ["read", "write", "edit", "bash", "submit_result"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ReadParams = { path: string; offset?: number; limit?: number };
export type WriteParams = { path: string; content: string };
export type EditParams = {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};
export type BashParams = { command: string; timeout_ms?: number };
export type SubmitParams = {
  summary: string;
  claims: string[];
  touched: string[];
  notes_for_reviewer?: string;
  blocked_reason?: string;
};

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  read: "Read a text file in the project. Returns numbered lines. `offset` is 1-based; `limit` defaults to 2000 lines.",
  write:
    "Create or overwrite a file in the project with the full content given. Parent directories are created.",
  edit: "Replace `old_string` with `new_string` in a file. `old_string` must match exactly once unless `replace_all` is true.",
  bash: "Run a shell command in the project directory and get its exit code and output. Use it to run tests, list files (ls, find) and search (rg or grep). Default timeout 120000 ms, at most 600000.",
  submit_result:
    "Finish the task. Call exactly once, last. `touched` lists every file you changed. If you cannot do the task without breaking a rule (for example a locked test is wrong), set `blocked_reason` instead of working around it.",
};

const MAX_LINES = 2000;
const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const half = MAX_OUTPUT / 2;
  return `${text.slice(0, half)}\n[... truncated ${text.length - MAX_OUTPUT} chars ...]\n${text.slice(-half)}`;
}

export type ToolOptions = {
  /** Project-relative paths written by earlier test units; write and edit refuse them. */
  lockedPaths: string[];
};

/**
 * The worker's tools as plain functions over a Sandbox. They throw on misuse; the OMP adapter
 * turns a throw into a tool error the model can read.
 */
export function createToolHandlers(sb: Sandbox, opts: ToolOptions) {
  const locked = new Set(opts.lockedPaths.map((p) => resolveInside(sb.root, p)));
  const assertWritable = (path: string) => {
    if (locked.has(resolveInside(sb.root, path))) {
      throw new Error(
        `${path} is locked (a test from an earlier unit); if it is wrong, report blocked`,
      );
    }
  };
  let submitted: WorkerResult | undefined;

  const handlers = {
    async read({ path, offset = 1, limit = MAX_LINES }: ReadParams) {
      const text = await sb.readFile(path);
      if (text === "") return "(empty file)";
      const lines = text.replace(/\n$/, "").split("\n");
      const start = Math.max(1, offset);
      return lines
        .slice(start - 1, start - 1 + Math.min(limit, MAX_LINES))
        .map((l, i) => `${start + i}\t${l}`)
        .join("\n");
    },
    async write({ path, content }: WriteParams) {
      assertWritable(path);
      await sb.writeFile(path, content);
      return `wrote ${path} (${new TextEncoder().encode(content).length} bytes)`;
    },
    async edit({ path, old_string, new_string, replace_all = false }: EditParams) {
      assertWritable(path);
      if (old_string === new_string) throw new Error("old_string and new_string are the same");
      const text = await sb.readFile(path);
      const count = old_string === "" ? 0 : text.split(old_string).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${path}`);
      if (count > 1 && !replace_all) {
        throw new Error(
          `old_string matches ${count} times in ${path}; make it unique or set replace_all`,
        );
      }
      await sb.writeFile(path, text.split(old_string).join(new_string));
      return `edited ${path} (${count} replacement${count === 1 ? "" : "s"})`;
    },
    async bash({ command, timeout_ms = DEFAULT_TIMEOUT_MS }: BashParams) {
      const r = await sb.exec(command, { timeoutMs: Math.min(timeout_ms, MAX_TIMEOUT_MS) });
      const head = `exit ${r.code}${r.timedOut ? " (timed out)" : ""}\n`;
      return truncate(head + r.stdout + (r.stderr ? `[stderr]\n${r.stderr}` : ""));
    },
    async submit_result(p: SubmitParams) {
      if (submitted) throw new Error("result already submitted");
      const parsed = WorkerResult.safeParse({
        schema: 1,
        summary: p.summary,
        claims: p.claims,
        touched: p.touched,
        ...(p.notes_for_reviewer ? { notes_for_reviewer: p.notes_for_reviewer } : {}),
        ...(p.blocked_reason ? { blocked: { reason: p.blocked_reason } } : {}),
      });
      if (!parsed.success) {
        throw new Error(
          `invalid result: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      }
      submitted = parsed.data;
      return "result recorded";
    },
  } satisfies Record<ToolName, (p: never) => Promise<string>>;

  return { handlers, result: () => submitted };
}
