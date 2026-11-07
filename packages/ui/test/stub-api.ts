import { type Api, ApiError } from "../src/api.ts";

/** An Api that answers each method from `answers` (a value, or an ApiError to throw) and records calls. */
export const stubApi = (
  answers: Record<string, unknown>,
): Api & { calls: [string, ...unknown[]][] } => {
  const calls: [string, ...unknown[]][] = [];
  return {
    calls,
    call: (async (method: string, ...args: unknown[]) => {
      calls.push([method, ...args]);
      if (!Object.hasOwn(answers, method)) throw new ApiError("daemon", `no stub for ${method}`);
      const a = answers[method];
      if (a instanceof Error) throw a;
      return a;
    }) as Api["call"],
  };
};
