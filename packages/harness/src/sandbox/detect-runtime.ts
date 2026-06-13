import { spawnSync } from "node:child_process";

/** Returns the first available container runtime CLI. */
export function detectContainerRuntime(
  preferred?: "docker" | "podman",
): string | undefined {
  const order: ("docker" | "podman")[] = preferred
    ? preferred === "docker"
      ? ["docker", "podman"]
      : ["podman", "docker"]
    : ["docker", "podman"];

  for (const runtime of order) {
    const probe = spawnSync(runtime, ["version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (probe.status === 0) {
      return runtime;
    }
  }
  return undefined;
}
