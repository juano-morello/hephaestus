import { runOk } from "@hephaestus/sandbox";

export type PrState = { state: "open" | "merged" | "closed"; mergeCommit?: string };

/** Where a changeset lands when its repos have a remote: one pull request per repo. */
export interface PullRequests {
  open(p: {
    repoDir: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ url: string }>;
  edit(p: { repoDir: string; url: string; body: string }): Promise<void>;
  status(p: { repoDir: string; url: string }): Promise<PrState>;
}

type Runner = (cmd: string[], opts?: { cwd?: string }) => Promise<string>;

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
    async edit({ repoDir, url, body }) {
      await run(["gh", "pr", "edit", url, "--body", body], { cwd: repoDir });
    },
    async status({ repoDir, url }) {
      const raw = JSON.parse(
        await run(["gh", "pr", "view", url, "--json", "state,mergeCommit"], { cwd: repoDir }),
      ) as {
        state: string;
        mergeCommit?: { oid?: string } | null;
      };
      const state = raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open";
      return { state, ...(raw.mergeCommit?.oid ? { mergeCommit: raw.mergeCommit.oid } : {}) };
    },
  };
}
