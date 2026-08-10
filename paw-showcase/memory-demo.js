/**
 * memory-demo.js — 记忆演示数据与筛选逻辑
 * 展示假数据列表（至少 4 条，类型含 preference/decision），
 * 支持按类型筛选（全部 / preference / decision）
 */
(function () {
  "use strict";

  // ── 假数据 ──
  const MEMORY_DATA = [
    {
      id: "mem-01",
      type: "preference",
      content: "用户偏好使用 TypeScript 而不是 JavaScript 编写后端服务。",
      time: "2025-01-15 14:32",
    },
    {
      id: "mem-02",
      type: "decision",
      content: "团队决定采用 pnpm 作为包管理器，并使用 workspace 组织 monorepo。",
      time: "2025-01-20 09:15",
    },
    {
      id: "mem-03",
      type: "preference",
      content: "用户习惯在提交前运行 prettier 和 eslint 进行代码格式化。",
      time: "2025-02-03 11:47",
    },
    {
      id: "mem-04",
      type: "decision",
      content: "架构决策：所有 Agent 的长期记忆统一使用 @paw/memory MemoryRuntime（Postgres）。",
      time: "2025-02-10 16:00",
    },
    {
      id: "mem-05",
      type: "preference",
      content: "用户倾向于使用函数式编程风格编写核心逻辑，避免类继承。",
      time: "2025-02-18 08:22",
    },
    {
      id: "mem-06",
      type: "decision",
      content: "决定将 Plan·Context·Memory 三层结构作为桌面 Agent 的标准架构。",
      time: "2025-03-01 13:45",
    },
    {
      id: "mem-07",
      type: "failure",
      content: "尝试调用 OpenAI GPT-4 接口时因 API Key 过期返回 401，已更新密钥重试成功。",
      time: "2025-03-05 10:18",
    },
  ];

  // ── DOM 引用 ──
  const container = document.getElementById("memory-list");
  const filterBtns = document.querySelectorAll(".filter-btn");
  let currentFilter = "all";

  // ── 渲染 ──
  function render(filter) {
    if (!container) return;

    const filtered =
      filter === "all"
        ? MEMORY_DATA
        : MEMORY_DATA.filter((item) => item.type === filter);

    if (filtered.length === 0) {
      container.innerHTML =
        '<p style="text-align:center;color:var(--color-text-secondary);grid-column:1/-1;padding:32px 0;">暂无匹配的记忆条目。</p>';
      return;
    }

    container.innerHTML = filtered
      .map(
        (item) => `
      <div class="memory-item">
        <div class="memory-item-header">
          <span class="memory-tag ${item.type}">${item.type}</span>
        </div>
        <div class="memory-item-content">${escapeHtml(item.content)}</div>
        <div class="memory-item-time">🕐 ${escapeHtml(item.time)}</div>
      </div>
    `
      )
      .join("");
  }

  // ── 简单的 HTML 转义 ──
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ── 筛选按钮绑定 ──
  function bindFilters() {
    filterBtns.forEach((btn) => {
      btn.addEventListener("click", function () {
        const filter = this.getAttribute("data-filter");
        if (!filter) return;

        currentFilter = filter;

        // 切换 active 状态
        filterBtns.forEach((b) => b.classList.remove("active"));
        this.classList.add("active");

        render(filter);
      });
    });
  }

  // ── 初始化 ──
  function init() {
    bindFilters();
    render("all");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
