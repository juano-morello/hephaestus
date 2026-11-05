import { describe, expect, test } from "bun:test";
import { connectTestClient, fakeDaemon } from "./harness.ts";

describe("heph mcp server", () => {
  test("server identifies itself as heph", async () => {
    const { client: daemon } = fakeDaemon({});
    const client = await connectTestClient({ client: daemon, workspace: () => undefined });
    expect(client.getServerVersion()?.name).toBe("heph");
    await client.close();
  });
});
