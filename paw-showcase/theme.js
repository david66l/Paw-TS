/**
 * theme.js — 深色/浅色主题切换
 * 写入 localStorage，刷新后保持
 */
(function () {
  const STORAGE_KEY = "paw-theme";
  const TOGGLE_ID = "theme-toggle";

  function getStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage 不可用时静默忽略
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }

  function getPreferredTheme() {
    const stored = getStoredTheme();
    if (stored === "dark" || stored === "light") return stored;
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      return "dark";
    }
    return "light";
  }

  function initTheme() {
    const theme = getPreferredTheme();
    applyTheme(theme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    setStoredTheme(next);
    updateToggleLabel(next);
  }

  function updateToggleLabel(theme) {
    const btn = document.getElementById(TOGGLE_ID);
    if (!btn) return;
    btn.textContent = theme === "dark" ? "☀️" : "🌙";
    btn.setAttribute("aria-label", theme === "dark" ? "切换到浅色模式" : "切换到深色模式");
  }

  // DOM 就绪后绑定事件
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }

  function setup() {
    initTheme();

    const btn = document.getElementById(TOGGLE_ID);
    if (btn) {
      btn.addEventListener("click", toggleTheme);
      const current = document.documentElement.getAttribute("data-theme") || "light";
      updateToggleLabel(current);
    }

    // 监听系统主题变化（当未设置 localStorage 时）
    try {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", function (e) {
        if (!getStoredTheme()) {
          applyTheme(e.matches ? "dark" : "light");
          updateToggleLabel(e.matches ? "dark" : "light");
        }
      });
    } catch {
      // 兼容不支持 addEventListener 的旧浏览器
    }
  }
})();
