export type ColorTheme = "calm" | "aurora" | "paper";
export type MaterialTheme = "soft" | "lens";

type Appearance = { color: ColorTheme; material: MaterialTheme };
const STORAGE_KEY = "paw.appearance";

export function readAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return {
      color: ["calm", "aurora", "paper"].includes(saved?.color)
        ? saved.color
        : "calm",
      material: saved?.material === "soft" ? "soft" : "lens",
    };
  } catch {
    return { color: "calm", material: "lens" };
  }
}

export function applyAppearance(appearance: Appearance): void {
  document.documentElement.dataset.colorTheme = appearance.color;
  // Paper has its own matte surface; retain the glass preference for switching back.
  document.documentElement.dataset.materialTheme =
    appearance.color === "paper" ? "paper" : appearance.material;
}

export function saveAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // The selected skin still works when local storage is unavailable.
  }
}
