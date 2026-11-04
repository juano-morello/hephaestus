// `heph doctor`: what this node needs to plan, build and land a run, checked one by one, each
// problem with the command that fixes it.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedConfig } from "@hephaestus/core";
import { createGit, targetBase } from "@hephaestus/engine";
import { openSandbox, run, type SandboxSpec, which } from "@hephaestus/sandbox";
import { findWorkspace, loadConfig, loadHomeConfig } from "./config.ts";
import { hephVersion } from "./version.ts";

export type CheckState = "ok" | "warn" | "fail" | "skip";
export type Check = { area: string; state: CheckState; detail: string; fix?: string };
export type DoctorReport = {
  version: string;
  build: string;
  node: string;
  checks: Check[];
  /** No check failed (warnings allowed). */
  ok: boolean;
};

/** What doctor asks the world; tests answer with fakes. */
export type DoctorEnv = {
  /** One tiny call to a model pattern: the model it resolved to, or why it can't be used. */
  probeModel(pattern: string, cwd: string): Promise<{ model: string } | { error: string }>;
  daemonUp(): Promise<boolean>;
  /** Says hello to a configured node; throws when it can't be reached. */
  helloNode(node: string): Promise<{ version?: string | undefined }>;
  ghLoggedIn(): Promise<boolean>;
};

const TEST_TIMEOUT_MS = 20 * 60_000;
const OMP_LOGIN =
  "log in on this machine: run omp, then /login (anthropic for claude/*, openai for openai/*)";

export async function doctor(o: {
  home: string;
  cwd: string;
  /** Also run each project's test command in the sandbox (slow: a full test run each). */
  tests: boolean;
  env: DoctorEnv;
}): Promise<DoctorReport> {
  const { version, build } = hephVersion();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // This node's own config.
  const homeFile = join(o.home, "config.yaml");
  const home = await loadHomeConfig(o.home);
  add(
    existsSync(homeFile)
      ? { area: "config", state: "ok", detail: `node ${home.node.id} (${homeFile})` }
      : {
          area: "config",
          state: "warn",
          detail: `no ${homeFile}: the node id is this host's name (${home.node.id}), which can change`,
          fix: `write node: { id: <a name> } to ${homeFile} (the installer does)`,
        },
  );

  // The workspace here, if any, and the config a run would use.
  let workspaceDir = findWorkspace(o.cwd);
  let inWorkspace = existsSync(join(workspaceDir, ".heph", "workspace.yaml"));
  let broken: string | undefined;
  let config: ResolvedConfig;
  try {
    config = (await loadConfig({ workspaceDir, home: o.home })).config;
  } catch (e) {
    // Checked with the node's config alone; the workspace is reported broken.
    broken = e instanceof Error ? e.message : String(e);
    workspaceDir = mkdtempSync(join(tmpdir(), "heph-doctor-none-"));
    inWorkspace = false;
    config = (await loadConfig({ workspaceDir, home: o.home })).config;
  }
  const projects = Object.entries(config.workspace.projects);
  if (broken)
    add({
      area: "workspace",
      state: "fail",
      detail: broken,
      fix: "fix the file and key named above (heph config explain shows every value)",
    });
  else if (!inWorkspace)
    add({
      area: "workspace",
      state: "skip",
      detail: `not in a workspace (${o.cwd})`,
      fix: "cd into your repo and run heph init",
    });
  else {
    const untested = projects.filter(([p]) => !config.projects[p]?.commands.test).map(([p]) => p);
    add({
      area: "workspace",
      state: untested.length ? "warn" : "ok",
      detail: `${config.workspace.name}: ${projects
        .map(([p]) => {
          const test = config.projects[p]?.commands.test;
          const lines = test?.trim().split("\n") ?? [];
          const shown = lines.length > 1 ? `a ${lines.length}-line script` : lines[0];
          return `${p} (${test ? `test: ${shown}` : "no test command"})`;
        })
        .join(", ")}`,
      ...(untested.length
        ? {
            fix: `set commands.test for ${untested.join(", ")} in its repo's .heph/config.yaml: without one, no unit there can be checked`,
          }
        : {}),
    });
  }

  // Every model the routing can pick: one tiny call each.
  const models = [
    ...new Set(
      Object.values(config.routing).flatMap((tiers) =>
        Object.values(tiers ?? {}).map((r) => r.model),
      ),
    ),
  ].sort();
  // One at a time: OMP sessions in one process can't start concurrently.
  const probes: { m: string; p: Awaited<ReturnType<DoctorEnv["probeModel"]>> }[] = [];
  for (const m of models) probes.push({ m, p: await o.env.probeModel(patternOf(m), o.cwd) });
  const failed = probes.filter((x) => "error" in x.p);
  add({
    area: "models",
    state: failed.length ? "fail" : "ok",
    detail: probes.map(({ m, p }) => `${m}: ${"error" in p ? p.error : p.model}`).join("\n"),
    ...(failed.length ? { fix: OMP_LOGIN } : {}),
  });

  // The sandbox units and gates run in.
  add(await sandboxCheck(config.sandbox, Object.values(config.projects)));

  // Git, and gh where a repo lands as pull requests.
  if (!which("git"))
    add({ area: "git", state: "fail", detail: "git is not installed", fix: "install git" });
  const repoDirs = Object.entries(config.workspace.repos).map(
    ([r, p]) => [r, resolve(workspaceDir, p)] as const,
  );
  const remotes: string[] = [];
  if (inWorkspace)
    for (const [r, dir] of repoDirs) if (await createGit(dir).remoteUrl("origin")) remotes.push(r);
  if (!remotes.length)
    add({
      area: "gh",
      state: "ok",
      detail: inWorkspace ? "not needed: no repo has a remote" : "not checked outside a workspace",
    });
  else
    add(
      (await o.env.ghLoggedIn())
        ? { area: "gh", state: "ok", detail: `logged in (pull requests for ${remotes.join(", ")})` }
        : {
            area: "gh",
            state: "fail",
            detail: `not logged in, and ${remotes.join(", ")} land as pull requests`,
            fix: "gh auth login -h github.com -p https -w && gh auth setup-git",
          },
    );

  // The daemon: optional, but without it a build lives and dies with the command.
  add(
    (await o.env.daemonUp())
      ? { area: "daemon", state: "ok", detail: "running" }
      : {
          area: "daemon",
          state: "warn",
          detail: "not running: heph run builds in the foreground and stops if you close it",
          fix: "install it as a service (bun run install:heph), or run heph daemon",
        },
  );

  // Every configured node.
  for (const node of Object.keys(home.nodes)) {
    if (node === home.node.id) continue;
    try {
      const h = await o.env.helloNode(node);
      add(
        h.version === version
          ? { area: `node ${node}`, state: "ok", detail: `heph ${h.version}` }
          : {
              area: `node ${node}`,
              state: "warn",
              detail: `heph ${h.version ?? "older than 0.1.0"} there, ${version} here`,
              fix: `install this version there (bun run install:heph -- --remote ${home.nodes[node]?.ssh ?? node})`,
            },
      );
    } catch (e) {
      add({
        area: `node ${node}`,
        state: "fail",
        detail: (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "unreachable",
        fix: `check ssh ${home.nodes[node]?.ssh ?? node} works without a password prompt`,
      });
    }
  }

  // Each project's test command, in the sandbox, on a clean checkout of what a run builds from.
  if (!o.tests || !inWorkspace)
    add({
      area: "tests",
      state: "skip",
      detail: inWorkspace
        ? "heph doctor --tests runs each project's test command in the sandbox"
        : "no workspace here",
    });
  else {
    const results: { project: string; ok: boolean; line: string }[] = [];
    for (const [p, proj] of projects) {
      const test = config.projects[p]?.commands.test;
      if (!test) continue;
      const repoDir = resolve(workspaceDir, config.workspace.repos[proj.repo] as string);
      const target = config.workspace.targets?.[proj.repo] ?? "main";
      results.push({
        project: p,
        ...(await testInSandbox({
          repoDir,
          path: proj.path,
          target,
          test,
          spec: (dir) =>
            config.sandbox.mode === "native"
              ? { mode: "native", hostDir: dir }
              : {
                  mode: "container",
                  hostDir: dir,
                  image: config.projects[p]?.image ?? config.sandbox.image,
                  runtime: config.sandbox.runtime,
                },
          mode: config.sandbox.mode,
        })),
      });
    }
    const bad = results.filter((r) => !r.ok);
    add({
      area: "tests",
      state: bad.length ? "fail" : results.length ? "ok" : "skip",
      detail: results.map((r) => `${r.project}: ${r.line}`).join("\n") || "no test commands",
      ...(bad.length
        ? {
            fix: "make the test command pass on a clean checkout of the target branch, offline (in the sandbox there is no network)",
          }
        : {}),
    });
  }

  return {
    version,
    build,
    node: home.node.id,
    checks,
    ok: !checks.some((c) => c.state === "fail"),
  };
}

/** `claude/claude-opus-5-5` -> `claude-opus-5-5`: the pattern OMP resolves, as the worker does. */
const patternOf = (model: string) => model.split("/").slice(1).join("/") || model;

async function sandboxCheck(
  sandbox: { mode: "container" | "native"; runtime: "docker" | "podman"; image: string },
  projects: { image?: string | undefined }[],
): Promise<Check> {
  if (sandbox.mode === "native") {
    const tool = process.platform === "darwin" ? "sandbox-exec" : "bwrap";
    return which(tool)
      ? { area: "sandbox", state: "ok", detail: `native, confined by ${tool}` }
      : {
          area: "sandbox",
          state: "fail",
          detail: `native mode needs ${tool}, which is not installed`,
          fix:
            tool === "bwrap"
              ? "sudo apt install bubblewrap"
              : "sandbox-exec ships with macOS; check PATH",
        };
  }
  const rt = sandbox.runtime;
  const info = await run([rt, "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 });
  if (info.code !== 0)
    return {
      area: "sandbox",
      state: "fail",
      detail: `container mode, but ${rt} isn't answering: ${info.stderr.trim().split("\n")[0] ?? ""}`,
      fix: `start ${rt}, or set sandbox: { mode: native } in ~/.heph/config.yaml`,
    };
  const images = [
    ...new Set([sandbox.image, ...projects.flatMap((p) => (p.image ? [p.image] : []))]),
  ];
  const missing: string[] = [];
  for (const image of images)
    if ((await run([rt, "image", "inspect", image], { timeoutMs: 15_000 })).code !== 0)
      missing.push(image);
  return missing.length
    ? {
        area: "sandbox",
        state: "warn",
        detail: `container (${rt}); not pulled yet: ${missing.join(", ")}`,
        fix: missing.map((i) => `${rt} pull ${i}`).join(" && "),
      }
    : { area: "sandbox", state: "ok", detail: `container (${rt}), images: ${images.join(", ")}` };
}

async function testInSandbox(a: {
  repoDir: string;
  path: string;
  target: string;
  test: string;
  mode: string;
  spec: (dir: string) => SandboxSpec;
}): Promise<{ ok: boolean; line: string }> {
  const git = createGit(a.repoDir);
  const wt = join(mkdtempSync(join(tmpdir(), "heph-doctor-")), "checkout");
  let base: string;
  try {
    base = await targetBase(git, a.target);
    await git.worktreeAddDetached(wt, base);
  } catch (e) {
    return {
      ok: false,
      line: `no checkout of ${a.target}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`,
    };
  }
  try {
    const dir = resolve(wt, a.path);
    if (!existsSync(dir)) return { ok: false, line: `${a.path} is not on ${a.target}` };
    let sb: Awaited<ReturnType<typeof openSandbox>>;
    try {
      sb = await openSandbox(a.spec(dir));
    } catch (e) {
      return {
        ok: false,
        line: `no sandbox: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`,
      };
    }
    try {
      const t = Date.now();
      const r = await sb.exec(a.test, { timeoutMs: TEST_TIMEOUT_MS });
      const s = ((Date.now() - t) / 1000).toFixed(1).replace(/\.0$/, "");
      if (r.code === 0) return { ok: true, line: `passes in the ${a.mode} sandbox (${s} s)` };
      const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-6).join(" | ");
      return {
        ok: false,
        line: `${a.test} ${r.timedOut ? "timed out" : `exited ${r.code}`} on ${base} in the ${a.mode} sandbox: ${tail}`,
      };
    } finally {
      await sb.dispose();
    }
  } finally {
    await git.worktreeRemove(wt).catch(() => {});
    rmSync(join(wt, ".."), { recursive: true, force: true });
  }
}

const MARK: Record<CheckState, string> = { ok: "ok", warn: "warn", fail: "FAIL", skip: "-" };

export function doctorText(r: DoctorReport): string {
  const lines = [`heph ${r.version} (${r.build}) on node ${r.node}`];
  const width = Math.max(10, ...r.checks.map((c) => c.area.length)) + 1;
  const indent = " ".repeat(2 + 5 + width);
  for (const c of r.checks) {
    const [first, ...rest] = c.detail.split("\n");
    lines.push(`  ${MARK[c.state].padEnd(5)}${c.area.padEnd(width)}${first}`);
    for (const l of rest) lines.push(`${indent}${l}`);
    if (c.fix && c.state !== "ok") lines.push(`${indent}fix: ${c.fix}`);
  }
  lines.push(r.ok ? "ready" : "not ready: fix the FAIL lines above");
  return `${lines.join("\n")}\n`;
}
