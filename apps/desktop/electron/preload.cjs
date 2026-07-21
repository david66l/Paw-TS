/**
 * 预加载：向渲染进程暴露安全的 Agent API。
 */
const { contextBridge, ipcRenderer } = require("electron");

function onChannel(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("pawDesktop", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  getMeta: () => ipcRenderer.invoke("agent:get-meta"),

  startRun: (opts) => ipcRenderer.invoke("agent:start-run", opts),

  abortRun: (requestId) => ipcRenderer.invoke("agent:abort", { requestId }),

  respondApproval: (opts) => ipcRenderer.invoke("agent:approval-respond", opts),

  respondAskUser: (opts) => ipcRenderer.invoke("agent:ask-respond", opts),

  finalizeConversation: (opts) =>
    ipcRenderer.invoke("agent:finalize-conversation", opts),

  listMemories: (opts) => ipcRenderer.invoke("agent:list-memories", opts || {}),

  doctor: (opts) => ipcRenderer.invoke("agent:doctor", opts || {}),

  listCheckpoints: (opts) =>
    ipcRenderer.invoke("agent:checkpoint-list", opts || {}),

  undoCheckpoint: (opts) =>
    ipcRenderer.invoke("agent:checkpoint-undo", opts || {}),

  listRuns: (opts) => ipcRenderer.invoke("agent:runs-list", opts || {}),

  loadRun: (opts) => ipcRenderer.invoke("agent:runs-load", opts || {}),

  fetchStatus: (opts) => ipcRenderer.invoke("agent:status", opts || {}),

  getSettings: (opts) => ipcRenderer.invoke("agent:settings-get", opts || {}),

  setSettings: (opts) => ipcRenderer.invoke("agent:settings-set", opts || {}),

  onReady: (cb) => onChannel("agent:ready", cb),
  onEvent: (cb) => onChannel("agent:event", cb),
  onRunDone: (cb) => onChannel("agent:run-done", cb),
  onError: (cb) => onChannel("agent:error", cb),
  onApprovalRequest: (cb) => onChannel("agent:approval-request", cb),
  onAskUserRequest: (cb) => onChannel("agent:ask-request", cb),
  onLog: (cb) => onChannel("agent:log", cb),
  onHostExit: (cb) => onChannel("agent:host-exit", cb),
  onMemoryFinalizeDone: (cb) => onChannel("agent:memory-finalize-done", cb),
  onMemoryListDone: (cb) => onChannel("agent:memory-list-done", cb),
  onDoctorDone: (cb) => onChannel("agent:doctor-done", cb),
  onCheckpointListDone: (cb) => onChannel("agent:checkpoint-list-done", cb),
  onCheckpointUndoDone: (cb) => onChannel("agent:checkpoint-undo-done", cb),
  onRunsListDone: (cb) => onChannel("agent:runs-list-done", cb),
  onRunsLoadDone: (cb) => onChannel("agent:runs-load-done", cb),
  onStatusDone: (cb) => onChannel("agent:status-done", cb),
  onSettingsDone: (cb) => onChannel("agent:settings-done", cb),
});
