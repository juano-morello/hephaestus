import { expect, test } from "bun:test";
import pkg from "../package.json";
import { hephVersion } from "../src/version.ts";

test("from a checkout, the build is the git commit", () => {
  expect(hephVersion().build).toMatch(/, from source$/);
});

test("git that cannot be spawned (a compiled binary's /$bunfs cwd) is unknown, not a crash", () => {
  const v = hephVersion({
    spawn: () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'git'"), {
        code: "ENOENT",
      });
    },
  });
  expect(v).toEqual({ version: pkg.version, build: "unknown" });
});

test("git that fails (not a repository) is unknown", () => {
  const v = hephVersion({ spawn: () => ({ exitCode: 128, stdout: Buffer.from("") }) });
  expect(v.build).toBe("unknown");
});
