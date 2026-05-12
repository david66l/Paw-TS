import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AskUserResolveInput, ToolApprovalInput } from "@paw/cli-core";

import { approvalPolicyWhenStrict } from "./approval-policy.js";
import { submitUserLine } from "./commands.js";
import { tuiStrictToolApprovalFromEnv } from "./env.js";
import { createRunSessionController } from "./run-session-controller.js";
import { ApprovalPicker } from "./ui/ApprovalPicker.js";
import { LogRowView } from "./ui/LogRowView.js";
import { NotificationToast } from "./ui/NotificationToast.js";
import type { StatusHud } from "./ui/StatusBar.js";
import { StatusBar } from "./ui/StatusBar.js";
import { ThinkingPreview } from "./ui/ThinkingPreview.js";
import type { Toast } from "./ui/NotificationToast.js";
import { appendRunEventRows } from "./ui/append-run-event.js";
import type { DisplayRow } from "./ui/display-rows.js";
import { PromptLine } from "./ui/PromptLine.js";
import { theme } from "./ui/themes.js";

import type { RunEventEnvelope } from "@paw/core";

const MAX_LOG_ROWS = 200;
const THINKING_PREVIEW_LINES = 6;
const MAX_INPUT_HISTORY = 500;

function lastNLines(text: string, n: number): string[] {
  const lines = text.split("\n");
  return lines.slice(-n);
}

export default function App() {
  const { exit } = useApp();
  const nextId = useRef(1);
  const [rows, setRows] = useState<DisplayRow[]>([
    { id: 0, variant: "welcome" },
  ]);
  const lineRef = useRef("");
  /** Insertion index 0…length; refs mirror {@link line} / {@link cursorCol} for Ink handlers. */
  const cursorColRef = useRef(0);
  const inputHistoryRef = useRef<string[]>([]);
  /** `null` = not browsing history; else index into {@link inputHistoryRef}. */
  const histNavIdxRef = useRef<number | null>(null);
  /** Line buffer before first Up-arrow in this browse session. */
  const histScratchRef = useRef("");
  const [cursorCol, setCursorCol] = useState(0);

  const pendingAskResolve = useRef<((line: string) => void) | null>(null);
  const pendingApprovalResolve = useRef<((approved: boolean) => void) | null>(
    null,
  );
  const [line, setLine] = useState("");

  /** Tool approval list (↑↓); index 0 = Allow, 1 = Deny. */
  const approvalIdxRef = useRef(0);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [, approvalRenderBump] = useState(0);

  const [hud, setHud] = useState<StatusHud>({
    cwd: process.cwd(),
    modelLabel: null,
    turn: null,
    maxSteps: null,
    phase: null,
    cost: null,
  });

  const [thinking, setThinking] = useState<{
    started: number;
    label: string;
    preview: string[];
  } | null>(null);
  /** Latest accumulated text from model.chunk (ref avoids re-render on every chunk). */
  const thinkingTextRef = useRef("");
  /** Pending throttle timeout for thinking preview updates. */
  const thinkingThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toastIdRef = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** Track active toast timeouts so we can cap and clean up. */
  const toastTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const currentRunIdRef = useRef<string>("");

  /** Scroll offset for log viewing (0 = at bottom). */
  const [scrollOffset, setScrollOffset] = useState(0);
  /** Terminal height to adapt visible row count. */
  const [termHeight, setTermHeight] = useState(process.stdout.rows || 24);

  /** Re-render ~10×/s while a model call is in flight so elapsed time updates. */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!thinking) {
      return;
    }
    const id = setInterval(() => {
      setTick((x) => x + 1);
    }, 100);
    return () => {
      clearInterval(id);
    };
  }, [thinking]);

  useEffect(() => {
    const onResize = () => setTermHeight(process.stdout.rows || 24);
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  const elapsedSec = thinking ? (Date.now() - thinking.started) / 1000 : 0;
  void tick;

  const addToast = useCallback((message: string, type: Toast["type"]) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => {
      const next = [...prev, { id, message, type }];
      // Cap at 3 toasts; evict oldest
      return next.slice(-3);
    });
    const timer = setTimeout(() => {
      toastTimeoutsRef.current.delete(timer);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
    toastTimeoutsRef.current.add(timer);
  }, []);

  const appendRow = useCallback((row: DisplayRow) => {
    setRows((prev) => [...prev, row].slice(-MAX_LOG_ROWS));
    // Auto-scroll to bottom when new content arrives
    setScrollOffset(0);
  }, []);

  const allocateId = useCallback(() => nextId.current++, []);

  const syncPrompt = useCallback((nextLine: string, nextCursor: number) => {
    lineRef.current = nextLine;
    const cc = Math.max(0, Math.min(nextCursor, nextLine.length));
    cursorColRef.current = cc;
    setLine(nextLine);
    setCursorCol(cc);
  }, []);

  const exitHistoryBrowse = useCallback(() => {
    histNavIdxRef.current = null;
  }, []);

  const pushHistoryEntry = useCallback((cmd: string) => {
    const t = cmd.trim();
    if (!t) {
      return;
    }
    const h = inputHistoryRef.current;
    if (h.length === 0 || h[h.length - 1] !== t) {
      h.push(t);
      if (h.length > MAX_INPUT_HISTORY) {
        h.shift();
      }
    }
  }, []);

  const pushText = useCallback(
    (message: string) => {
      const lines = message.replace(/\r\n/g, "\n").split("\n");
      for (const t of lines) {
        appendRow({ id: allocateId(), variant: "text", text: t });
      }
    },
    [appendRow, allocateId],
  );

  const onRunEvent = useCallback(
    (envelope: RunEventEnvelope) => {
      const ev = envelope.event;
      if (ev.type === "model.request") {
        thinkingTextRef.current = "";
        setThinking({
          started: Date.now(),
          label: ev.label,
          preview: [],
        });
        setHud((h) => ({ ...h, modelLabel: ev.label, phase: "model" }));
      }
      if (ev.type === "model.chunk") {
        thinkingTextRef.current = ev.text;
        if (!thinkingThrottleRef.current) {
          thinkingThrottleRef.current = setTimeout(() => {
            thinkingThrottleRef.current = null;
            setThinking((prev) =>
              prev
                ? {
                    ...prev,
                    preview: lastNLines(thinkingTextRef.current, THINKING_PREVIEW_LINES),
                  }
                : null,
            );
          }, 200);
        }
      }
      if (ev.type === "model.done") {
        if (thinkingThrottleRef.current) {
          clearTimeout(thinkingThrottleRef.current);
          thinkingThrottleRef.current = null;
        }
        thinkingTextRef.current = "";
        setThinking(null);
        setHud((h) => ({ ...h, phase: "idle" }));
      }
      if (ev.type === "cost.update") {
        setHud((h) => ({
          ...h,
          cost: {
            totalTokens: ev.totalTokens,
            estimatedCostUsd: ev.estimatedCostUsd,
          },
        }));
      }
      if (ev.type === "loop.tick") {
        setHud((h) => ({
          ...h,
          turn: ev.turn,
          maxSteps: ev.maxSteps,
        }));
      }
      if (ev.type === "phase") {
        setHud((h) => ({ ...h, phase: ev.name }));
      }
      if (ev.type === "tool.call") {
        setHud((h) => ({ ...h, phase: "tool" }));
      }
      if (ev.type === "user.reply.required") {
        setHud((h) => ({ ...h, phase: "reply" }));
      }
      if (ev.type === "tool.approval.pending") {
        setHud((h) => ({ ...h, phase: "approval" }));
      }
      if (ev.type === "tool.approval.resolved") {
        setHud((h) => ({
          ...h,
          phase: ev.approved ? "tool" : "approval:denied",
        }));
        if (!ev.approved) {
          addToast(`${ev.tool} denied`, "warn");
        }
      }
      if (ev.type === "run.started") {
        currentRunIdRef.current = envelope.runId;
      }
      if (ev.type === "run.completed") {
        setHud((h) => ({ ...h, phase: "idle" }));
        pendingAskResolve.current = null;
        pendingApprovalResolve.current = null;
        setApprovalMenuOpen(false);
        addToast(
          ev.status === "completed" ? "Run completed" : "Run failed",
          ev.status === "completed" ? "ok" : "fail",
        );
      }
      if (ev.type === "run.failed") {
        setHud((h) => ({ ...h, phase: "idle" }));
        pendingAskResolve.current = null;
        pendingApprovalResolve.current = null;
        setApprovalMenuOpen(false);
      }

      appendRunEventRows(appendRow, allocateId, envelope);
    },
    [appendRow, allocateId, addToast],
  );

  const clear = useCallback(() => {
    setRows([{ id: nextId.current++, variant: "welcome" }]);
  }, []);

  const sessionCtl = useMemo(() => createRunSessionController(), []);

  const strictToolApproval = useMemo(() => tuiStrictToolApprovalFromEnv(), []);
  const strictApprovalPolicy = useMemo(
    () => approvalPolicyWhenStrict(strictToolApproval),
    [strictToolApproval],
  );

  const orchestratorHooks = useMemo(
    () => ({
      resolveAskUser: async (input: AskUserResolveInput) => {
        pushText(`[Reply needed] ${input.question}`);
        return await new Promise<string>((resolve) => {
          pendingAskResolve.current = resolve;
        });
      },
      resolveToolApproval: async (input: ToolApprovalInput) => {
        let snippet = "";
        try {
          snippet = JSON.stringify(input.args);
        } catch {
          snippet = String(input.args);
        }
        pushText(
          `[Approval] ${input.tool} ${snippet.slice(0, 160)}${snippet.length > 160 ? "…" : ""}`,
        );
        approvalIdxRef.current = 0;
        setApprovalMenuOpen(true);
        approvalRenderBump((n) => n + 1);
        try {
          return await new Promise<boolean>((resolve) => {
            pendingApprovalResolve.current = resolve;
          });
        } finally {
          setApprovalMenuOpen(false);
          approvalRenderBump((n) => n + 1);
        }
      },
      ...(strictApprovalPolicy !== undefined
        ? { approvalPolicy: strictApprovalPolicy }
        : {}),
    }),
    [pushText, strictApprovalPolicy],
  );

  useInput((input, key) => {
    // Ctrl+C is always handled first — even during approval or ask_user.
    if (key.ctrl && input === "c") {
      if (pendingApprovalResolve.current) {
        const appr = pendingApprovalResolve.current;
        pendingApprovalResolve.current = null;
        setApprovalMenuOpen(false);
        approvalRenderBump((n) => n + 1);
        appr(false);
      }
      if (sessionCtl.abortIfRunning()) {
        pushText("Abort requested — cancelling run…");
        return;
      }
      exit();
      return;
    }

    if (pendingApprovalResolve.current) {
      if (key.escape) {
        const appr = pendingApprovalResolve.current;
        pendingApprovalResolve.current = null;
        setApprovalMenuOpen(false);
        approvalRenderBump((n) => n + 1);
        appr(false);
        return;
      }
      if (key.upArrow) {
        approvalIdxRef.current = Math.max(0, approvalIdxRef.current - 1);
        approvalRenderBump((n) => n + 1);
        return;
      }
      if (key.downArrow) {
        approvalIdxRef.current = Math.min(1, approvalIdxRef.current + 1);
        approvalRenderBump((n) => n + 1);
        return;
      }
      if (key.return) {
        const appr = pendingApprovalResolve.current;
        if (appr) {
          pendingApprovalResolve.current = null;
          const approved = approvalIdxRef.current === 0;
          setApprovalMenuOpen(false);
          approvalRenderBump((n) => n + 1);
          appr(approved);
        }
        return;
      }
      return;
    }

    if (key.upArrow) {
      const h = inputHistoryRef.current;
      if (h.length === 0) {
        return;
      }
      if (histNavIdxRef.current === null) {
        histScratchRef.current = lineRef.current;
        histNavIdxRef.current = h.length - 1;
      } else {
        histNavIdxRef.current = Math.max(0, histNavIdxRef.current - 1);
      }
      const text = h[histNavIdxRef.current] ?? "";
      syncPrompt(text, text.length);
      return;
    }

    if (key.downArrow) {
      if (histNavIdxRef.current === null) {
        return;
      }
      const h = inputHistoryRef.current;
      const next = histNavIdxRef.current + 1;
      if (next >= h.length) {
        histNavIdxRef.current = null;
        const restore = histScratchRef.current;
        syncPrompt(restore, restore.length);
        return;
      }
      histNavIdxRef.current = next;
      const text = h[next] ?? "";
      syncPrompt(text, text.length);
      return;
    }

    if (key.leftArrow) {
      exitHistoryBrowse();
      syncPrompt(lineRef.current, cursorColRef.current - 1);
      return;
    }

    if (key.rightArrow) {
      exitHistoryBrowse();
      syncPrompt(lineRef.current, cursorColRef.current + 1);
      return;
    }

    if (key.return) {
      const raw = lineRef.current;
      const v = raw.trim();
      exitHistoryBrowse();

      const askFn = pendingAskResolve.current;
      if (askFn) {
        pendingAskResolve.current = null;
        syncPrompt("", 0);
        pushHistoryEntry(v);
        askFn(v);
        return;
      }

      if (!v) {
        return;
      }

      pushHistoryEntry(v);
      syncPrompt("", 0);

      if (!sessionCtl.tryBeginSubmission()) {
        syncPrompt(raw, raw.length);
        pushText(
          "Busy — wait for the current command to finish, or Ctrl+C to abort a running agent.",
        );
        return;
      }

      const cwd = process.cwd();
      void (async () => {
        try {
          await submitUserLine(v, {
            cwd,
            pushText,
            onRunEvent,
            exit,
            clear,
            runSession: sessionCtl.runSession,
            currentRunId: currentRunIdRef.current,
            orchestratorHooks,
          });
        } catch (e: unknown) {
          pushText(e instanceof Error ? e.message : String(e));
        } finally {
          sessionCtl.endSubmission();
        }
      })();
      return;
    }

    if (key.backspace) {
      exitHistoryBrowse();
      const cur = cursorColRef.current;
      if (cur === 0) {
        return;
      }
      const s = lineRef.current;
      syncPrompt(s.slice(0, cur - 1) + s.slice(cur), cur - 1);
      return;
    }

    if (key.delete) {
      exitHistoryBrowse();
      const cur = cursorColRef.current;
      const s = lineRef.current;
      if (cur >= s.length) {
        return;
      }
      syncPrompt(s.slice(0, cur) + s.slice(cur + 1), cur);
      return;
    }

    if (key.pageUp) {
      setScrollOffset((prev) => prev + Math.max(4, Math.floor((termHeight - 8) / 2)));
      return;
    }

    if (key.pageDown) {
      setScrollOffset((prev) => Math.max(0, prev - Math.max(4, Math.floor((termHeight - 8) / 2))));
      return;
    }

    if (input) {
      exitHistoryBrowse();
      const cur = cursorColRef.current;
      const s = lineRef.current;
      syncPrompt(s.slice(0, cur) + input + s.slice(cur), cur + input.length);
    }
  });

  const visibleLogRows = Math.max(6, termHeight - 10);
  const start = Math.max(0, rows.length - visibleLogRows - scrollOffset);
  const end = Math.min(rows.length, start + visibleLogRows);
  const visible = rows.slice(start, end);

  return (
    <Box flexDirection="column">
      <NotificationToast toasts={toasts} />
      <ThinkingPreview
        elapsedSec={elapsedSec}
        label={thinking?.label ?? "model"}
        lines={thinking?.preview ?? []}
        visible={thinking !== null}
      />
      <Box flexDirection="column" flexGrow={1} marginBottom={1}>
        {visible.map((row) => (
          <LogRowView key={row.id} row={row} />
        ))}
      </Box>
      <Box marginBottom={0}>
        <StatusBar hud={hud} />
      </Box>
      {approvalMenuOpen ? (
        <ApprovalPicker selectedIndex={approvalIdxRef.current} />
      ) : null}
      <Box borderColor={theme.panelBorder} borderStyle="round" paddingX={1}>
        <Text>
          <Text bold color={theme.accent}>
            ›{" "}
          </Text>
          {approvalMenuOpen ? (
            <Text dimColor>(↑↓ Enter to approve tool)</Text>
          ) : (
            <PromptLine cursor={cursorCol} line={line} />
          )}
        </Text>
      </Box>
    </Box>
  );
}
