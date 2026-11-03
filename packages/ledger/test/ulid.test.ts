import { describe, expect, test } from "bun:test";
import { createUlid, decodeTime } from "../src/ulid.ts";

const fixedRandom = (byte: number) => (n: number) => new Uint8Array(n).fill(byte);

describe("ulid", () => {
  test("is 26 Crockford base32 characters encoding the timestamp", () => {
    const ulid = createUlid({ now: () => 1_762_200_000_000, random: fixedRandom(7) });
    const id = ulid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(decodeTime(id)).toBe(1_762_200_000_000);
  });

  test("is strictly increasing within one millisecond", () => {
    const ulid = createUlid({ now: () => 1_000, random: fixedRandom(0xff - 1) });
    const ids = Array.from({ length: 50 }, () => ulid());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  test("sorts by time across milliseconds", () => {
    let t = 1_000;
    const ulid = createUlid({ now: () => t, random: fixedRandom(0xff) });
    const a = ulid();
    t = 1_001;
    const b = ulid();
    expect(a < b).toBe(true);
  });

  test("stays increasing when the clock goes backwards", () => {
    let t = 5_000;
    const ulid = createUlid({ now: () => t, random: fixedRandom(1) });
    const a = ulid();
    t = 4_000;
    const b = ulid();
    expect(a < b).toBe(true);
    expect(decodeTime(b)).toBe(5_000);
  });

  test("throws when the random part overflows within one millisecond", () => {
    const ulid = createUlid({ now: () => 1_000, random: fixedRandom(0xff) });
    ulid();
    expect(() => ulid()).toThrow("ulid: random overflow");
  });

  test("an overflow does not reset the generator", () => {
    let t = 1_000;
    const ulid = createUlid({ now: () => t, random: fixedRandom(0xff) });
    const a = ulid();
    expect(() => ulid()).toThrow("ulid: random overflow");
    expect(() => ulid()).toThrow("ulid: random overflow");
    t = 1_001;
    expect(ulid() > a).toBe(true);
  });

  test("rejects a timestamp outside 48 bits", () => {
    expect(() => createUlid({ now: () => 2 ** 48 })()).toThrow("ulid: time out of range");
  });
});
