import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ConfigError, explainConfig, findLine, loadConfig } from "../src/config.ts";
import { run } from "../src/main.ts";

let root: string;
let home: string;
let ws: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "heph-config-"));
  home = join(root, "home");
  ws = join(root, "ws");
  await mkdir(home, { recursive: true });
  await mkdir(ws, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const WORKSPACE = `repos:
  server: ./server
  web: ./web
projects:
  server: { repo: server, path: ., stack: go }
  web-app: { repo: web, path: app, stack: ts }
  web-docs: { repo: web, path: docs, stack: md }
targets:
  server: main
`;

async function loadError(opts: Parameters<typeof loadConfig>[0]): Promise<ConfigError> {
  try {
    await loadConfig(opts);
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  test("with no files uses the defaults and an implied single-repo workspace", async () => {
    const { config, sources } = await loadConfig({ workspaceDir: ws, home });
    const name = basename(ws);
    expect(config.node.id).toBe(hostname());
    expect(config.limits.attempts_per_unit).toBe(3);
    expect(config.sandbox.image).toBe("alpine:3.20");
    expect(config.routing.planner?.default).toEqual({
      model: "claude/claude-opus-5-5",
      effort: "high",
    });
    expect(config.workspace.repos).toEqual({ [name]: "." });
    expect(config.workspace.projects[name]).toEqual({ repo: name, path: ".", stack: "unknown" });
    expect(config.projects[name]).toEqual({ commands: {} });
    expect(sources["limits.attempts_per_unit"]).toBe("default");
    expect(sources[`workspace.repos.${name}`]).toBe("default");
    expect(Object.values(sources).every((s) => s === "default")).toBe(true);
  });

  test("the home layer overrides defaults leaf by leaf", async () => {
    const file = join(home, "config.yaml");
    await put(
      file,
      "node:\n  id: devserver\nlimits:\n  attempts_per_unit: 5\nsandbox:\n  runtime: podman\n",
    );
    const { config, sources } = await loadConfig({ workspaceDir: ws, home });
    expect(config.node.id).toBe("devserver");
    expect(config.limits).toEqual({
      attempts_per_unit: 5,
      budget_tokens: 20000,
      gate_timeout_ms: 600000,
      attempt_timeout_ms: 1200000,
      idle_timeout_ms: 600000,
      transport_retries: 2,
      parallel: 3,
    });
    expect(config.sandbox.runtime).toBe("podman");
    expect(sources["limits.attempts_per_unit"]).toBe(file);
    expect(sources["limits.budget_tokens"]).toBe("default");
    expect(sources["sandbox.runtime"]).toBe(file);
    expect(sources["node.id"]).toBe(file);
  });

  test("nodes, workspaces and sync come from the home layer; the workspace is named after its dir", async () => {
    const empty = await loadConfig({ workspaceDir: ws, home });
    expect(empty.config.nodes).toEqual({});
    expect(empty.config.workspaces).toEqual({});
    expect(empty.config.sync).toEqual({ interval_s: 30 });
    expect(empty.config.workspace.name).toBe(basename(ws));
    expect(empty.sources["workspace.name"]).toBe("default");

    const file = join(home, "config.yaml");
    await put(
      file,
      [
        "nodes:",
        "  denver: { ssh: denver, heph: ~/bin/heph, labels: [linux, unattended], preferred: true }",
        "workspaces:",
        "  legendsao: /home/juano/code/legendsao",
        "sync: { interval_s: 10 }",
        "",
      ].join("\n"),
    );
    await put(join(ws, ".heph", "workspace.yaml"), `name: calc\n${WORKSPACE}`);
    const { config, sources } = await loadConfig({ workspaceDir: ws, home });
    expect(config.nodes.denver).toEqual({
      ssh: "denver",
      heph: "~/bin/heph",
      labels: ["linux", "unattended"],
      preferred: true,
    });
    expect(config.workspaces).toEqual({ legendsao: "/home/juano/code/legendsao" });
    expect(config.sync.interval_s).toBe(10);
    expect(config.workspace.name).toBe("calc");
    expect(sources["workspace.name"]).toBe(join(ws, ".heph", "workspace.yaml"));
  });

  test("a node needs an ssh destination", async () => {
    await put(join(home, "config.yaml"), "nodes:\n  denver: { preferred: true }\n");
    expect((await loadError({ workspaceDir: ws, home })).issues[0]).toMatchObject({
      key: "nodes.denver.ssh",
    });
  });

  test("a route in a later layer replaces the whole route", async () => {
    const file = join(home, "config.yaml");
    await put(file, "routing:\n  implementer:\n    complex: { model: claude/opus }\n");
    const { config, sources } = await loadConfig({ workspaceDir: ws, home });
    expect(config.routing.implementer?.complex).toEqual({ model: "claude/opus" });
    expect(config.routing.implementer?.standard).toEqual({
      model: "claude/claude-sonnet-5-5",
      effort: "medium",
    });
    expect(sources["routing.implementer.complex.model"]).toBe(file);
    expect(sources["routing.implementer.complex.effort"]).toBeUndefined();
  });

  test("a later layer's top route replaces the earlier one whole", async () => {
    const file = join(home, "config.yaml");
    await put(file, "routing:\n  implementer:\n    top: { model: claude/other }\n");
    const { config, sources } = await loadConfig({ workspaceDir: ws, home });
    expect(config.routing.implementer?.top).toEqual({ model: "claude/other" });
    expect(sources["routing.implementer.top.effort"]).toBeUndefined();
  });

  test("the workspace layer supplies repos, projects and targets", async () => {
    const file = join(ws, ".heph", "workspace.yaml");
    await put(file, WORKSPACE);
    const { config, sources } = await loadConfig({ workspaceDir: ws, home });
    expect(Object.keys(config.workspace.projects)).toEqual(["server", "web-app", "web-docs"]);
    expect(config.workspace.targets).toEqual({ server: "main" });
    expect(config.projects.server).toEqual({ commands: {} });
    expect(sources["workspace.projects.web-app.path"]).toBe(file);
    expect(sources["workspace.targets.server"]).toBe(file);
  });

  test("the repo layer sets project commands, image and gates", async () => {
    await put(join(ws, ".heph", "workspace.yaml"), WORKSPACE);
    const file = join(ws, "web", ".heph", "config.yaml");
    await put(
      file,
      "projects:\n  web-app:\n    commands: { test: bun test, lint: biome ci . }\n    image: oven/bun:1\n    gates: [tests, lint]\n",
    );
    const { config, sources } = await loadConfig({ workspaceDir: ws, home });
    expect(config.projects["web-app"]).toEqual({
      commands: { test: "bun test", lint: "biome ci ." },
      image: "oven/bun:1",
      gates: ["tests", "lint"],
    });
    expect(config.projects["web-docs"]).toEqual({ commands: {} });
    expect(sources["projects.web-app.commands.test"]).toBe(file);
    expect(sources["projects.web-app.gates"]).toBe(file);
  });

  test("the project shorthand applies to the repo's only project", async () => {
    await put(join(ws, ".heph", "workspace.yaml"), WORKSPACE);
    const file = join(ws, "server", ".heph", "config.yaml");
    await put(
      file,
      "project:\n  commands:\n    test: go test -race ./...\n    typecheck: go vet ./...\n",
    );
    const { config, sources } = await loadConfig({ workspaceDir: ws, home });
    expect(config.projects.server?.commands).toEqual({
      test: "go test -race ./...",
      typecheck: "go vet ./...",
    });
    expect(sources["projects.server.commands.typecheck"]).toBe(file);
  });

  test("the project shorthand works in an implied workspace", async () => {
    await put(join(ws, ".heph", "config.yaml"), "project:\n  commands: { test: make test }\n");
    const { config } = await loadConfig({ workspaceDir: ws, home });
    expect(config.projects[basename(ws)]?.commands.test).toBe("make test");
  });

  test("overrides win over every file and are sourced as flag", async () => {
    await put(join(home, "config.yaml"), "limits:\n  attempts_per_unit: 5\n");
    await put(join(ws, ".heph", "workspace.yaml"), WORKSPACE);
    await put(join(ws, "server", ".heph", "config.yaml"), "project:\n  image: golang:1.24\n");
    const { config, sources } = await loadConfig({
      workspaceDir: ws,
      home,
      overrides: { "limits.attempts_per_unit": 7, "projects.server.image": "golang:1.25" },
    });
    expect(config.limits.attempts_per_unit).toBe(7);
    expect(config.projects.server?.image).toBe("golang:1.25");
    expect(sources["limits.attempts_per_unit"]).toBe("flag");
    expect(sources["projects.server.image"]).toBe("flag");
  });
});

describe("loadConfig errors", () => {
  test("a bad value names the file and line", async () => {
    const file = join(home, "config.yaml");
    await put(file, "# node settings\nlimits:\n  budget_tokens: 100\n  attempts_per_unit: lots\n");
    const err = await loadError({ workspaceDir: ws, home });
    expect(err.issues[0]).toMatchObject({ file, line: 4, key: "limits.attempts_per_unit" });
    expect(err.message).toContain(`${file}:4: limits.attempts_per_unit:`);
  });

  test("an unknown key names its line", async () => {
    const file = join(home, "config.yaml");
    await put(file, "sandbox:\n  mode: native\n  imgae: alpine\n");
    const err = await loadError({ workspaceDir: ws, home });
    expect(err.issues[0]).toMatchObject({ file, line: 3, key: "sandbox.imgae" });
  });

  test("a bad value inside a flow mapping points at its line", async () => {
    const file = join(ws, ".heph", "workspace.yaml");
    await put(file, WORKSPACE.replace("stack: md", "stack: ''"));
    const err = await loadError({ workspaceDir: ws, home });
    expect(err.issues[0]).toMatchObject({
      file,
      line: 7,
      key: "workspace.projects.web-docs.stack",
    });
  });

  test("the project shorthand is refused when the repo has several projects", async () => {
    await put(join(ws, ".heph", "workspace.yaml"), WORKSPACE);
    const file = join(ws, "web", ".heph", "config.yaml");
    await put(file, "\nproject:\n  commands: { test: bun test }\n");
    const err = await loadError({ workspaceDir: ws, home });
    expect(err.issues[0]).toMatchObject({ file, line: 2, key: "project" });
    expect(err.message).toContain("2 projects");
  });

  test("a repo cannot configure another repo's project", async () => {
    await put(join(ws, ".heph", "workspace.yaml"), WORKSPACE);
    const file = join(ws, "server", ".heph", "config.yaml");
    await put(file, "projects:\n  web-app:\n    image: x\n");
    const err = await loadError({ workspaceDir: ws, home });
    expect(err.issues[0]).toMatchObject({ file, line: 2, key: "projects.web-app" });
  });

  test("invalid YAML names the file", async () => {
    const file = join(home, "config.yaml");
    await put(file, "limits: [1,\n");
    const err = await loadError({ workspaceDir: ws, home });
    expect(err.issues[0]?.file).toBe(file);
  });

  test("a bad override is sourced as flag", async () => {
    const err = await loadError({ workspaceDir: ws, home, overrides: { "sandbox.mode": "vm" } });
    expect(err.issues[0]).toMatchObject({ file: "flag", key: "sandbox.mode" });
    expect(err.message).toContain("flag: sandbox.mode:");
  });
});

describe("findLine", () => {
  const text = "a:\n  b:\n    - x\n    - y: 1\n  c: { d: 2 }\nb: 3\n";
  test("follows block keys and sequence items", () => {
    expect(findLine(text, ["a", "b", 1, "y"])).toBe(4);
    expect(findLine(text, ["b"])).toBe(6);
  });
  test("stops at a flow mapping's line", () => {
    expect(findLine(text, ["a", "c", "d"])).toBe(5);
  });
  test("returns undefined when the first key is absent", () => {
    expect(findLine(text, ["z"])).toBeUndefined();
  });
});

describe("explainConfig", () => {
  test("prints every leaf with its value and source", async () => {
    const file = join(home, "config.yaml");
    await put(file, "limits:\n  attempts_per_unit: 5\n");
    await put(join(ws, ".heph", "config.yaml"), "project:\n  gates: [tests, lint]\n");
    const lines = explainConfig(await loadConfig({ workspaceDir: ws, home }));
    expect(lines).toContain(`limits.attempts_per_unit = 5  (${file})`);
    expect(lines).toContain("limits.budget_tokens = 20000  (default)");
    expect(lines).toContain("limits.parallel = 3  (default)");
    expect(lines).toContain("sandbox.image = alpine:3.20  (default)");
    expect(lines).toContain(
      `projects.${basename(ws)}.gates = ["tests","lint"]  (${join(ws, ".heph", "config.yaml")})`,
    );
    expect(lines[0]).toBe(`node.id = ${hostname()}  (default)`);
  });
});

describe("heph config explain", () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      ctx: {
        cwd: ws,
        env: { HEPH_HOME: home },
        stdout: (s: string) => out.push(s),
        stderr: (s: string) => err.push(s),
      },
    };
  }

  test("prints the explain lines", async () => {
    const { out, ctx } = io();
    expect(await run(["config", "explain"], ctx)).toBe(0);
    expect(out.join("")).toContain("limits.attempts_per_unit = 3  (default)");
  });

  test("--json wraps config and sources in the envelope", async () => {
    const { out, ctx } = io();
    expect(await run(["config", "explain", "--json"], ctx)).toBe(0);
    const body = JSON.parse(out.join(""));
    expect(body).toMatchObject({ schema: 1, command: "config explain", ok: true });
    expect(body.data.config.limits.attempts_per_unit).toBe(3);
    expect(body.data.sources["limits.attempts_per_unit"]).toBe("default");
  });

  test("--set overrides a value", async () => {
    const { out, ctx } = io();
    await run(["config", "explain", "--json", "--set", "limits.attempts_per_unit=4"], ctx);
    const body = JSON.parse(out.join(""));
    expect(body.data.config.limits.attempts_per_unit).toBe(4);
    expect(body.data.sources["limits.attempts_per_unit"]).toBe("flag");
  });

  test("finds the workspace from a subdirectory", async () => {
    await put(join(ws, ".heph", "workspace.yaml"), WORKSPACE);
    await mkdir(join(ws, "server", "cmd"), { recursive: true });
    const { out, ctx } = io();
    await run(["config", "explain", "--json"], { ...ctx, cwd: join(ws, "server", "cmd") });
    const body = JSON.parse(out.join(""));
    expect(Object.keys(body.data.config.workspace.repos)).toEqual(["server", "web"]);
  });

  test("a config error is ok: false with exit 1", async () => {
    await put(join(home, "config.yaml"), "limits:\n  attempts_per_unit: lots\n");
    const { out, ctx } = io();
    expect(await run(["config", "explain", "--json"], ctx)).toBe(1);
    const body = JSON.parse(out.join(""));
    expect(body).toMatchObject({ schema: 1, command: "config explain", ok: false });
    expect(body.error.message).toContain("config.yaml:2: limits.attempts_per_unit:");
  });

  test("an unknown command fails without --json on stderr", async () => {
    const { err, ctx } = io();
    expect(await run(["frobnicate"], ctx)).toBe(1);
    expect(err.join("")).toContain("unknown command");
  });
});

describe("run from the home directory", () => {
  test("~/.heph/config.yaml is the node's config, not a repo's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "heph-homedir-"));
    await put(
      join(dir, ".heph", "config.yaml"),
      "node: { id: denver }\nsandbox: { mode: native }\n",
    );
    const { config } = await loadConfig({ workspaceDir: dir, home: join(dir, ".heph") });
    expect(config.node.id).toBe("denver");
    expect(config.sandbox.mode).toBe("native");
  });
});
