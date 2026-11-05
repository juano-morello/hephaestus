import { runOk } from "@hephaestus/sandbox";

export type PrState = {
  state: "open" | "merged" | "closed";
  mergeCommit?: string;
  /** The branch the pull request is based on (merges into). */
  base?: string;
};
export type PrReadiness = { ready: true; head: string } | { ready: false; reason: string };

/** Where a changeset lands when its repos have a remote: one pull request per repo. */
export interface PullRequests {
  open(p: {
    repoDir: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ url: string }>;
  /** The pull request whose head is `head`, in any state, if there is one. */
  find(p: {
    repoDir: string;
    head: string;
  }): Promise<{ url: string; state: PrState["state"] } | undefined>;
  edit(p: { repoDir: string; url: string; body: string }): Promise<void>;
  /** Points the pull request at another base branch (a stacked run's parent landed). */
  setBase(p: { repoDir: string; url: string; base: string }): Promise<void>;
  status(p: { repoDir: string; url: string }): Promise<PrState>;
  /** Open, not a draft, mergeable and with every check green. */
  readiness(p: { repoDir: string; url: string }): Promise<PrReadiness>;
  /** Merges only if the PR head is still `head`. */
  merge(p: { repoDir: string; url: string; head: string }): Promise<{ mergeCommit: string }>;
  /** Why this node couldn't open pull requests for the repo, or undefined when it can. */
  preflight?(p: { repoDir: string }): Promise<string | undefined>;
}

const CAN_OPEN = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

type Check = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
};
const FAILED = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

type Runner = (cmd: string[], opts?: { cwd?: string }) => Promise<string>;

/** `PATCH repos/<owner>/<repo>/pulls/<n>` with one field, through `gh api`. */
async function patchPull(run: Runner, repoDir: string, url: string, field: string) {
  const u = new URL(url);
  const [owner, repo, kind, number] = u.pathname.split("/").filter(Boolean);
  if (kind !== "pull" || !owner || !repo || !number)
    throw new Error(`not a pull request url: ${url}`);
  await run(
    [
      "gh",
      "api",
      "--hostname",
      u.hostname,
      "-X",
      "PATCH",
      `repos/${owner}/${repo}/pulls/${number}`,
      "-f",
      field,
      "--silent",
    ],
    { cwd: repoDir },
  );
}

/** Pull requests through the GitHub CLI, run in each repo's directory with your gh login. */
export function ghPullRequests(run: Runner = runOk): PullRequests {
  return {
    async open({ repoDir, head, base, title, body }) {
      const out = await run(
        ["gh", "pr", "create", "--head", head, "--base", base, "--title", title, "--body", body],
        {
          cwd: repoDir,
        },
      );
      const url = out.trim().split("\n").at(-1) ?? "";
      if (!/^https?:\/\//.test(url)) throw new Error(`gh pr create returned no url: ${out.trim()}`);
      return { url };
    },
    async find({ repoDir, head }) {
      const list = JSON.parse(
        await run(["gh", "pr", "list", "--head", head, "--state", "all", "--json", "url,state"], {
          cwd: repoDir,
        }),
      ) as { url: string; state: string }[];
      const pr = list.find((p) => p.state === "OPEN") ?? list[0];
      if (!pr) return undefined;
      const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open";
      return { url: pr.url, state };
    },
    // REST, not gh pr edit: older gh (2.46, Ubuntu's) asks GraphQL for Projects (classic)
    // cards there, which GitHub has removed, and the edit fails.
    edit: ({ repoDir, url, body }) => patchPull(run, repoDir, url, `body=${body}`),
    setBase: ({ repoDir, url, base }) => patchPull(run, repoDir, url, `base=${base}`),
    async status({ repoDir, url }) {
      const raw = JSON.parse(
        await run(["gh", "pr", "view", url, "--json", "state,mergeCommit,baseRefName"], {
          cwd: repoDir,
        }),
      ) as {
        state: string;
        mergeCommit?: { oid?: string } | null;
        baseRefName?: string;
      };
      const state = raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open";
      return {
        state,
        ...(raw.mergeCommit?.oid ? { mergeCommit: raw.mergeCommit.oid } : {}),
        ...(raw.baseRefName ? { base: raw.baseRefName } : {}),
      };
    },
    async readiness({ repoDir, url }) {
      const pr = JSON.parse(
        await run(
          [
            "gh",
            "pr",
            "view",
            url,
            "--json",
            "state,isDraft,mergeable,headRefOid,statusCheckRollup",
          ],
          {
            cwd: repoDir,
          },
        ),
      ) as {
        state: string;
        isDraft: boolean;
        mergeable: string;
        headRefOid: string;
        statusCheckRollup?: Check[];
      };
      if (pr.state !== "OPEN")
        return { ready: false, reason: `pull request is ${pr.state.toLowerCase()}` };
      if (pr.isDraft) return { ready: false, reason: "pull request is a draft" };
      if (pr.mergeable === "CONFLICTING")
        return { ready: false, reason: "pull request has merge conflicts" };
      if (pr.mergeable !== "MERGEABLE")
        return { ready: false, reason: "mergeability not computed yet, try again" };
      const checks = pr.statusCheckRollup ?? [];
      const name = (c: Check) => c.name ?? c.context ?? "check";
      const verdict = (c: Check) => (c.conclusion || c.state || "").toUpperCase();
      const failing = checks.filter((c) => FAILED.has(verdict(c))).map(name);
      if (failing.length) return { ready: false, reason: `checks failing: ${failing.join(", ")}` };
      const pending = checks.filter((c) => !PASSED.has(verdict(c))).map(name);
      if (pending.length)
        return { ready: false, reason: `checks still running: ${pending.join(", ")}` };
      return { ready: true, head: pr.headRefOid };
    },
    async preflight({ repoDir }) {
      let permission: string;
      try {
        permission = (
          await run(
            ["gh", "repo", "view", "--json", "viewerPermission", "-q", ".viewerPermission"],
            { cwd: repoDir },
          )
        ).trim();
      } catch (e) {
        return `gh can't reach the repo: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (CAN_OPEN.has(permission)) return undefined;
      return `gh's account has ${permission || "no"} access, and opening pull requests needs WRITE`;
    },
    async merge({ repoDir, url, head }) {
      await run(["gh", "pr", "merge", url, "--merge", "--match-head-commit", head], {
        cwd: repoDir,
      });
      const after = await this.status({ repoDir, url });
      if (after.state !== "merged" || !after.mergeCommit)
        throw new Error(`gh pr merge did not merge ${url}`);
      return { mergeCommit: after.mergeCommit };
    },
  };
}
