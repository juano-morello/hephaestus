/** What `heph handoff --wait` asked for: N seconds, or as long as one attempt may run. */
export type Wait = number | "attempt";

const BAD_NUMBER =
  "--wait takes a number of seconds of at least 1, or nothing to wait up to the attempt timeout";
const BAD_WORD = "--wait takes seconds, or nothing; put it after the run and node";

const seconds = (text: string): number => {
  const n = /^\d+$/.test(text) ? Number.parseInt(text, 10) : 0;
  if (n < 1) throw new Error(BAD_NUMBER);
  return n;
};

/**
 * Takes `--wait [seconds]` out of argv, because util.parseArgs cannot read a flag whose value is
 * optional. `--wait` alone (last, or before another flag) means "attempt"; `--wait N` and
 * `--wait=N` mean N seconds; a word after `--wait` is an error rather than a guess, since it may
 * be the run id of `heph handoff --wait <run> <node>`.
 */
export function parseWaitFlag(argv: string[]): { argv: string[]; wait?: Wait } {
  const at = argv.findIndex((a) => a === "--wait" || a.startsWith("--wait="));
  if (at < 0) return { argv };
  const token = argv[at] as string;
  if (token.startsWith("--wait=")) {
    return { argv: argv.filter((_, i) => i !== at), wait: seconds(token.slice("--wait=".length)) };
  }
  const next = argv[at + 1];
  if (next === undefined || next.startsWith("-")) {
    return { argv: argv.filter((_, i) => i !== at), wait: "attempt" };
  }
  if (/^\d+$/.test(next)) {
    return { argv: argv.filter((_, i) => i !== at && i !== at + 1), wait: seconds(next) };
  }
  throw new Error(BAD_WORD);
}
