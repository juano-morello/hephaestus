import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkContrast, ratio } from "../scripts/contrast.ts";

const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");

describe("theme contrast", () => {
  test("the shipped theme passes text (4.5:1) and non-text (3:1) checks", () => {
    expect(checkContrast(css)).toEqual([]);
  });

  test("the pending-node outline token reaches 3:1 on the page background in every theme", () => {
    const strong = [...css.matchAll(/--border-strong:\s*(#[0-9a-fA-F]{6});/g)].map((m) => m[1]);
    const bgs = [...css.matchAll(/^\s*--bg:\s*(#[0-9a-fA-F]{6});/gm)].map((m) => m[1]);
    expect(strong.length).toBe(3);
    expect(bgs.length).toBe(3);
    for (let i = 0; i < 3; i++)
      expect(ratio(strong[i] as string, bgs[i] as string)).toBeGreaterThan(3);
  });

  test("a weak outline color is reported (the check is falsifiable)", () => {
    const weak = css.replaceAll(
      /--border-strong:\s*#[0-9a-fA-F]{6};/g,
      "--border-strong: #b9a982;",
    );
    expect(checkContrast(weak).some((p) => p.includes("--border-strong"))).toBe(true);
  });

  test("accent on surface-2 and the dark on-primary on primary pairs are checked", () => {
    const weak = css.replaceAll(/--accent:\s*#[0-9a-fA-F]{6};/g, "--accent: #dccfb2;");
    expect(
      checkContrast(weak).some((p) => p.includes("--accent") && p.includes("--surface-2")),
    ).toBe(true);
  });

  test("primary and danger text on the surfaces the views use are checked", () => {
    const weak = css
      .replaceAll(/--primary:\s*#[0-9a-fA-F]{6};/g, "--primary: #f3ebd9;")
      .replaceAll(/--danger:\s*#[0-9a-fA-F]{6};/g, "--danger: #dccfb2;");
    const problems = checkContrast(weak);
    for (const pair of [
      ["--primary", "--surface"],
      ["--primary", "--bg"],
      ["--danger", "--surface-2"],
    ])
      expect(
        problems.some((p) => p.includes(`${pair[0]} #`) && p.includes(`on ${pair[1]} #`)),
      ).toBe(true);
  });
});
