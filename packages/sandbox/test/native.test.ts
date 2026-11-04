import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openSandbox } from "../src/sandbox.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();

async function native() {
  const root = dir();
  const sb = await openSandbox({ mode: "native", hostDir: root });
  return { root: realpathSync(root), sb };
}

describe("native sandbox", () => {
  test("runs commands in the project dir", async () => {
    const { root, sb } = await native();
    expect(sb.kind).toBe("native");
    expect(sb.root).toBe(root);
    const r = await sb.exec("pwd -P; echo hi >&2; exit 2");
    expect(r).toEqual({ code: 2, stdout: `${root}\n`, stderr: "hi\n", timedOut: false });
    mkdirSync(join(root, "sub"));
    expect((await sb.exec("pwd -P", { cwd: "sub" })).stdout).toBe(`${join(root, "sub")}\n`);
    await sb.dispose();
  });

  test("commands see a scrubbed environment", async () => {
    const { root, sb } = await native();
    process.env.HEPH_TEST_SECRET = "s3cret";
    const r = await sb.exec('printf "%s|%s" "$HEPH_TEST_SECRET" "$HOME"');
    delete process.env.HEPH_TEST_SECRET;
    // HOME is a scratch directory, not the project: tools' caches must not land in the diff.
    const [secret, home] = r.stdout.split("|");
    expect(secret).toBe("");
    expect(home).not.toStartWith(root);
    await sb.exec('mkdir -p "$HOME/.cache/x" && echo y > "$HOME/.cache/x/f"');
    expect((await sb.exec("ls -A")).stdout).toBe("");
    await sb.dispose();
  });

  test.skipIf(!Bun.which("go"))(
    "Go uses the host's module cache, read-only and offline, with a build cache in temp",
    async () => {
      const { root, sb } = await native();
      const host = Bun.spawnSync(["go", "env", "GOMODCACHE"]).stdout.toString().trim();
      const r = await sb.exec("go env GOMODCACHE GOPROXY GOTOOLCHAIN GOCACHE");
      const [modcache, proxy, toolchain, cache] = r.stdout.trim().split("\n");
      expect({ modcache, proxy, toolchain }).toEqual({
        modcache: host,
        proxy: "off",
        toolchain: "local",
      });
      expect(cache).not.toStartWith(root);
      await sb.dispose();
    },
  );

  test("a command past its timeout is killed", async () => {
    const { sb } = await native();
    const r = await sb.exec("sleep 5; true", { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
  });

  test("reads and writes inside the project, creating directories", async () => {
    const { root, sb } = await native();
    await sb.writeFile("inventory/stack.go", "package inventory\n");
    expect(readFileSync(join(root, "inventory/stack.go"), "utf8")).toBe("package inventory\n");
    expect(await sb.readFile("inventory/stack.go")).toBe("package inventory\n");
    expect(await sb.readFile(join(root, "inventory/stack.go"))).toBe("package inventory\n");
  });

  test("rejects paths and cwds outside the project", async () => {
    const { sb } = await native();
    await expect(sb.readFile("../outside.txt")).rejects.toThrow("path escapes the sandbox");
    await expect(sb.readFile("/etc/hosts")).rejects.toThrow("path escapes the sandbox");
    await expect(sb.writeFile("../../x", "x")).rejects.toThrow("path escapes the sandbox");
    await expect(sb.exec("pwd", { cwd: ".." })).rejects.toThrow("path escapes the sandbox");
  });

  test("rejects symlinks that point outside, for reads and for writes", async () => {
    const { root, sb } = await native();
    const outside = dir();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    symlinkSync(outside, join(root, "linkdir"));
    await expect(sb.readFile("link.txt")).rejects.toThrow("path escapes the sandbox");
    await expect(sb.writeFile("link.txt", "x")).rejects.toThrow("path escapes the sandbox");
    await expect(sb.writeFile("linkdir/new.txt", "x")).rejects.toThrow("path escapes the sandbox");
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });
});

describe("native sandbox confinement", () => {
  test("commands can write in the project and in temp, nowhere else", async () => {
    const { root, sb } = await native();
    const outside = dir();
    const r = await sb.exec(
      `echo in > inside.txt && t=$(mktemp) && echo t > "$t" && echo ok; echo out > ${outside}/x.txt`,
    );
    expect(r.stdout).toBe("ok\n");
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(root, "inside.txt"), "utf8")).toBe("in\n");
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });

  test("commands cannot read denied paths but can read the rest of the system", async () => {
    const secret = dir();
    writeFileSync(join(secret, "id_ed25519"), "PRIVATE KEY");
    const root = dir();
    const sb = await openSandbox({ mode: "native", hostDir: root, denyRead: [secret] });
    const r = await sb.exec(
      `cat ${secret}/id_ed25519; echo "exit=$?"; test -r /etc/hosts && echo hosts-ok`,
    );
    expect(r.stdout).not.toContain("PRIVATE KEY");
    expect(r.stdout).toContain("exit=1");
    expect(r.stdout).toContain("hosts-ok");
  });

  test("commands have no network", async () => {
    const { sb } = await native();
    const r = await sb.exec("curl -s -m 3 http://1.1.1.1 >/dev/null 2>&1; echo net=$?");
    expect(r.stdout).not.toBe("net=0\n");
  });

  test("commands can serve and connect on loopback, as tests that start a server do", async () => {
    const { sb } = await native();
    const r = await sb.exec(
      `python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(); socket.create_connection(s.getsockname()); print('loopback-ok')"`,
    );
    expect(r.stdout).toBe("loopback-ok\n");
  });

  test("the default deny list covers credentials in the home directory", async () => {
    const { defaultDenyRead } = await import("../src/native.ts");
    const list = defaultDenyRead("/home/u");
    for (const p of [
      "/home/u/.ssh",
      "/home/u/.aws",
      "/home/u/.config/gh",
      "/home/u/.omp",
      "/home/u/.gnupg",
    ]) {
      expect(list).toContain(p);
    }
  });
});
