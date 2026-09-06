import {
  DEFAULT_AGENT_SEEDS,
  createInputToMarkdown,
  loadAgentRegistryReadonly,
  parseAgentMarkdown,
} from "@paw/agent";
import { type LanguageModel, createDeepSeekFlashModel } from "@paw/models";
import type { PawSettingsLocal } from "@paw/settings";

/** Reuse configuration data only; execution always belongs to Paw Next. */
export function desktopAgentModels(
  workspaceRoot: string,
  main: LanguageModel,
  settings: PawSettingsLocal,
) {
  const specs = new Map(
    DEFAULT_AGENT_SEEDS.map((seed) => [
      seed.id,
      parseAgentMarkdown(createInputToMarkdown(seed), seed.id),
    ]),
  );
  for (const spec of loadAgentRegistryReadonly(workspaceRoot).list())
    specs.set(spec.id, spec);
  let flash: LanguageModel | undefined;
  const choose = (preference: string) => {
    if (preference !== "flash") return main;
    flash ??= createDeepSeekFlashModel(workspaceRoot) ?? main;
    return flash;
  };
  const models: Record<string, LanguageModel> = {};
  const preferences: Record<string, string> = {};
  for (const spec of specs.values())
    if (spec?.kind === "worker") {
      preferences[spec.id] = spec.model;
      // inherit uses the selected root model in the new runtime.
      if (spec.model !== "inherit") models[spec.id] = choose(spec.model);
    }
  const mode =
    settings.agent_mode ??
    (settings as Record<string, unknown>).collaboration_mode;
  const root =
    mode === "orchestrated" || mode === "team" || mode === "multi"
      ? specs.get("lihua")
      : undefined;
  return {
    model: root ? choose(root.model) : main,
    models,
    preferences,
    rootPrompt: root?.prompt,
  };
}
