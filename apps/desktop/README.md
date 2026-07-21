# @paw/desktop

Paw Mac 桌面端：**Electron + React + TypeScript**。

- 三栏布局：侧栏 / 对话 / 右侧 Plan·Changes·Context·Memory  
- 浅色液态玻璃（对齐 `prototypes/ui5-1to1`）：`GlassPanel`（CSS 仿真，非 SwiftUI 系统材质）  
- **已接入** `@paw/agent`：Electron 主进程 spawn Bun `agent-host/run.ts`，行协议转发事件  
- 支持流式回复、工具调用芯片、Markdown（`react-markdown` + `remark-gfm` + `remark-breaks`）、快捷示例与新对话

## 开发

在仓库根目录：

```bash
bun install
# 若 electron 报 failed to install correctly，补下二进制：
cd apps/desktop && bun run rebuild-electron && cd ../..
bun run desktop
```

或：

```bash
cd apps/desktop && bun run dev
```

会启动 Vite（5173）并打开 Electron 窗口。

仅校验前端类型/打包（不启窗口）：

```bash
cd apps/desktop && bun run typecheck && bun run build
```

## 目录

```
apps/desktop/
  electron/          主进程 + preload
  src/
    components/      壳组件（自研，无 Ant Design）
    styles/          设计 token + 全局样式
  index.html
  vite.config.ts
```

## 架构

```text
React UI  --ipc-->  Electron 主进程  --stdin/stdout JSON-->  bun agent-host
                                                              └─ runStubRun / @paw/agent
```

- 工作区默认：monorepo 根目录  
- 工具审批：修改性工具弹审批卡（允许 / 拒绝 / 本会话始终允许），子 Agent 与根 Agent 共享串行审批通道  
- ask_user：模型提问渲染为内联提问卡，回答以「问题条 + 用户气泡」沉淀进聊天流  
- 错误恢复：errorBar 带「重试」按钮，一键重发最近失败的任务  
- 过程可视化：工具执行卡（实时进度 + 结果摘要）+ Changed files 卡（+/− 统计 + diff 预览，含 apply_patch）内联进聊天流  
- 状态语义：用户中止显示「已中止」（非失败）；agent-host 崩溃自动重启，中断任务可一键重试  
- 消息操作：悬停复制（含未聚焦回退）/ 编辑重发；删除会话需二次确认  
- Agents 面板：花名册可展开看 agent 配置（模型/步数/读写/工具）；子 Agent 实时工具流（child.* 事件驱动）；tab 角标 = 活跃数  
- 并行写冲突防护：同批并行子 Agent 共享文件锁表（先到先得、等待 20s、超时冲突失败），锁等待/冲突进子 Agent 工具流 + 行内「锁冲突」徽标  
- Plan 面板：进度条（N of M steps · 百分比）+ 当前步骤高亮与进行中计时 + 六态图标（completed/running/pending/failed/blocked/skipped）  
- 新会话 `resumeSession: false`（不把旧 AppState 拼进任务目标）

## 后续

1. ~~工具审批弹窗（替代自动批准）~~ ✅ 已完成（含子 Agent 审批透传）
2. 右侧 Memory / Plan / Changes 接真实数据 ✅ 已完成
3. 对照 Figma 细化视觉  
4. 可选：选工作区目录  
