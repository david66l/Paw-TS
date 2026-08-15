import { describe, expect, test } from "bun:test";

import { toolDefinitions, toolNameReverseMap } from "@paw/harness";

import {
  CapabilityExposureShadowV1,
  capabilityPhaseToolsV1,
  inventoryCapabilitiesV1,
  searchCapabilitiesV1,
} from "../src/capability-exposure.js";

describe("capability exposure shadow v1", () => {
  const definitions = toolDefinitions();
  const toolNameMap = toolNameReverseMap();

  test("builds a stable categorized inventory", () => {
    const inventory = inventoryCapabilitiesV1(definitions, toolNameMap);
    expect(inventory).toHaveLength(definitions.length);
    expect(inventory.map((entry) => entry.name)).toEqual(
      [...inventory.map((entry) => entry.name)].sort(),
    );
    expect(
      inventory.find((entry) => entry.name === "workspace.run_shell")?.category,
    ).toBe("execution");
    expect(
      inventory.find((entry) => entry.name === "workspace.web_search")
        ?.category,
    ).toBe("external");
    expect(
      inventory.find((entry) => entry.name === "workspace.list_dir")?.core,
    ).toBe(true);
  });

  test("supports exact selection and keyword discovery", () => {
    const inventory = inventoryCapabilitiesV1(definitions, toolNameMap);
    expect(
      searchCapabilitiesV1(inventory, "select:workspace.notebook_edit").map(
        (entry) => entry.name,
      ),
    ).toEqual(["workspace.notebook_edit"]);
    expect(
      searchCapabilitiesV1(inventory, "search the web for documentation").map(
        (entry) => entry.name,
      ),
    ).toContain("workspace.web_search");
  });

  test("estimates savings without changing provider-visible exposure", () => {
    const shadow = new CapabilityExposureShadowV1({
      definitions,
      toolNameMap,
      countTokens: (tools) => JSON.stringify(tools).length,
    });
    const snapshot = shadow.snapshot("fix the parser and run its tests");
    expect(snapshot.mode).toBe("shadow");
    expect(snapshot.suggestedToolCount).toBeLessThan(snapshot.fullToolCount);
    expect(snapshot.estimatedSavingsTokens).toBeGreaterThan(0);

    const hit = shadow.observe(0, "fix the parser", [
      "workspace.read_file",
      "workspace.edit_file",
    ]);
    expect(hit.outcome).toBe("hit");
    expect(hit.exposedToolCount).toBe(snapshot.fullToolCount);

    const fallback = shadow.observe(1, "fix the parser", [
      "workspace.web_search",
    ]);
    expect(fallback.outcome).toBe("fallback");
    expect(fallback.outsideSuggestion).toEqual(["workspace.web_search"]);
  });

  test("adds git status only when the host phase makes it relevant", () => {
    const shadow = new CapabilityExposureShadowV1({
      definitions,
      toolNameMap,
      countTokens: (tools) => JSON.stringify(tools).length,
    });
    const initial = capabilityPhaseToolsV1({ mutationRevision: 0 });
    expect(initial).toEqual(["workspace.git_status"]);
    expect(shadow.suggestedTools("fix the parser", initial)).toContain(
      "workspace.git_status",
    );

    const editing = capabilityPhaseToolsV1({
      mutationRevision: 1,
      diffInspectedRevision: 0,
    });
    expect(shadow.suggestedTools("fix the parser", editing)).not.toContain(
      "workspace.git_status",
    );

    const finishing = capabilityPhaseToolsV1({
      mutationRevision: 1,
      diffInspectedRevision: 1,
    });
    expect(
      shadow.observe(4, "fix the parser", ["workspace.git_status"], finishing)
        .outcome,
    ).toBe("hit");
  });
});
