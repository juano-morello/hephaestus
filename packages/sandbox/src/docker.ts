import type { ContainerSpec, Sandbox } from "./sandbox.ts";

export async function openContainer(_spec: ContainerSpec): Promise<Sandbox> {
  throw new Error("container mode is not built yet");
}
