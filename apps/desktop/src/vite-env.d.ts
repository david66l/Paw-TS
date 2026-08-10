/// <reference types="vite/client" />

export type DesktopRunEventEnvelope = {
  readonly seq?: number;
  readonly runId?: string;
  readonly event: {
    readonly type: string;
    readonly text?: string;
    readonly tool?: string;
    readonly summary?: string;
    readonly ok?: boolean;
    readonly message?: string;
    readonly status?: string;
    readonly [key: string]: unknown;
  };
};

export type CheckpointRow = {
  readonly seq: number;
  readonly tool: string;
  readonly targets: readonly string[];
  readonly savedAt: number;
};

export type RunSummaryRow = {
  readonly runId: string;
  readonly goal: string;
  readonly status: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly eventCount: number;
  readonly toolCallCount: number;
  readonly modelLabel?: string;
  readonly finalMessage?: string;
};

export type RunEventRow = {
  readonly seq?: number;
  readonly type: string;
  readonly summary: string;
  readonly tool?: string;
  readonly ok?: boolean;
  readonly text?: string;
};

export type AgentRosterEntry = {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly emoji?: string;
  readonly kind: string;
  readonly description?: string;
  readonly childPolicy?: string;
  readonly canSpawn?: boolean;
  readonly model?: string;
  readonly maxSteps?: number;
  readonly tools?: "inherit" | readonly string[];
};

export type HostStatus = {
  readonly workspaceRoot: string;
  readonly modelLabel: string;
  readonly skillsCount: number;
  readonly skillsDir: string;
  readonly agentsCount?: number;
  readonly agents?: readonly AgentRosterEntry[];
};

export type PawDesktopApi = {
  readonly platform: string;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
  getMeta: () => Promise<{
    repoRoot: string;
    platform: string;
    agentReady: boolean;
  }>;
  startRun: (opts: {
    goal: string;
    workspaceRoot?: string;
    maxSteps?: number;
    requestId?: string;
    conversationId?: string;
    history?: readonly {
      role: "user" | "assistant";
      content: string;
    }[];
  }) => Promise<{ requestId: string; workspaceRoot: string }>;
  abortRun: (requestId: string) => Promise<{ ok: boolean }>;
  respondApproval: (opts: {
    requestId: string;
    approvalId: string;
    approved: boolean;
    always?: boolean;
  }) => Promise<{ ok: boolean }>;
  respondAskUser: (opts: {
    requestId: string;
    askId: string;
    answer: string;
  }) => Promise<{ ok: boolean }>;
  finalizeConversation: (opts: {
    conversationId: string;
    finalMessage?: string;
    requestId?: string;
  }) => Promise<{ ok: boolean; requestId?: string; reason?: string }>;
  listMemories: (opts?: {
    limit?: number;
    type?: string;
    workspaceRoot?: string;
    requestId?: string;
  }) => Promise<{ ok: boolean; requestId?: string; reason?: string }>;
  doctor: (opts?: {
    workspaceRoot?: string;
    requestId?: string;
  }) => Promise<{ ok: boolean; requestId?: string }>;
  listCheckpoints: (opts: {
    runId: string;
    workspaceRoot?: string;
    requestId?: string;
  }) => Promise<{ ok: boolean; requestId?: string }>;
  undoCheckpoint: (opts: {
    runId: string;
    workspaceRoot?: string;
    requestId?: string;
  }) => Promise<{ ok: boolean; requestId?: string }>;
  listRuns: (opts?: {
    workspaceRoot?: string;
    requestId?: string;
  }) => Promise<{ ok: boolean; requestId?: string }>;
  loadRun: (opts: {
    runId: string;
    workspaceRoot?: string;
    limit?: number;
    requestId?: string;
  }) => Promise<{ ok: boolean; requestId?: string }>;
  fetchStatus: (opts?: {
    workspaceRoot?: string;
    requestId?: string;
  }) => Promise<{ ok: boolean; requestId?: string }>;
  getSettings: (opts?: {
    workspaceRoot?: string;
    requestId?: string;
  }) => Promise<{ ok: boolean; requestId?: string }>;
  setSettings: (opts: {
    workspaceRoot?: string;
    provider?: string;
    approvalMode?: "ask" | "auto";
    requestId?: string;
  }) => Promise<{ ok: boolean; requestId?: string }>;
  onSettingsDone: (
    cb: (payload: {
      requestId: string;
      ok: boolean;
      provider?: string;
      approvalMode: "ask" | "auto";
      presets: { id: string; model: string; baseUrl?: string }[];
      error?: string;
    }) => void,
  ) => () => void;
  onReady: (cb: () => void) => () => void;
  onEvent: (
    cb: (payload: {
      requestId: string;
      event: DesktopRunEventEnvelope;
    }) => void,
  ) => () => void;
  onRunDone: (
    cb: (payload: {
      requestId: string;
      result: { runId: string; status: string; message: string };
    }) => void,
  ) => () => void;
  onError: (
    cb: (payload: { requestId: string; message: string }) => void,
  ) => () => void;
  onApprovalRequest: (
    cb: (payload: {
      requestId: string;
      approvalId: string;
      tool: string;
      summary: string;
      argsPreview: string;
    }) => void,
  ) => () => void;
  onAskUserRequest: (
    cb: (payload: {
      requestId: string;
      askId: string;
      question: string;
      timeoutSec: number | null;
    }) => void,
  ) => () => void;
  onLog: (cb: (payload: { level: string; text: string }) => void) => () => void;
  onHostExit: (cb: (payload: { code: number | null }) => void) => () => void;
  onMemoryFinalizeDone: (
    cb: (payload: {
      requestId: string;
      conversationId: string;
      completed: boolean;
      taskId?: string;
    }) => void,
  ) => () => void;
  onMemoryListDone?: (
    cb: (payload: {
      requestId: string;
      ok: boolean;
      items: unknown;
      error?: string;
    }) => void,
  ) => () => void;
  onDoctorDone: (
    cb: (payload: {
      requestId: string;
      ok: boolean;
      text: string;
    }) => void,
  ) => () => void;
  onCheckpointListDone: (
    cb: (payload: {
      requestId: string;
      ok: boolean;
      runId: string;
      items: CheckpointRow[];
      error?: string;
    }) => void,
  ) => () => void;
  onCheckpointUndoDone: (
    cb: (payload: {
      requestId: string;
      ok: boolean;
      runId: string;
      restored: CheckpointRow | null;
      error?: string;
    }) => void,
  ) => () => void;
  onRunsListDone: (
    cb: (payload: {
      requestId: string;
      ok: boolean;
      items: RunSummaryRow[];
      error?: string;
    }) => void,
  ) => () => void;
  onRunsLoadDone: (
    cb: (payload: {
      requestId: string;
      ok: boolean;
      runId: string;
      events: RunEventRow[];
      total: number;
      error?: string;
    }) => void,
  ) => () => void;
  onStatusDone: (
    cb: (payload: {
      requestId: string;
      ok: boolean;
      workspaceRoot: string;
      modelLabel: string;
      skillsCount: number;
      skillsDir: string;
      agentsCount?: number;
      agents?: readonly AgentRosterEntry[];
      error?: string;
    }) => void,
  ) => () => void;
  onSettingsDone: (
    cb: (payload: {
      requestId: string;
      ok: boolean;
      provider?: string;
      approvalMode: "ask" | "auto";
      presets: { id: string; model: string; baseUrl?: string }[];
      error?: string;
    }) => void,
  ) => () => void;
};

declare global {
  interface Window {
    readonly pawDesktop?: PawDesktopApi;
  }
}
