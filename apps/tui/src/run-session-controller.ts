/**
 * TUI-only: serializes Enter submissions and exposes {@link StubRunSession} for
 * Ctrl+C abort. Pairing of begin/end for stub-run lives in `@paw/cli-core` {@link runStubRun}.
 */

import type { StubRunSession } from "@paw/cli-core";

export interface RunSessionController {
  /** True if Enter already dispatched a line and it has not finished. */
  readonly isSubmissionBusy: () => boolean;
  /** Start handling one submitted line; false if another is still running. */
  readonly tryBeginSubmission: () => boolean;
  readonly endSubmission: () => void;
  /** Passed through {@link submitUserLine} → {@link runStubRun}. */
  readonly runSession: StubRunSession;
  /** Abort active stub-run if any; returns whether an abort was sent. */
  readonly abortIfRunning: () => boolean;
}

export function createRunSessionController(): RunSessionController {
  let submissionBusy = false;
  let activeAbort: AbortController | null = null;

  return {
    isSubmissionBusy: () => submissionBusy,

    tryBeginSubmission() {
      if (submissionBusy) {
        return false;
      }
      submissionBusy = true;
      return true;
    },

    endSubmission() {
      submissionBusy = false;
    },

    runSession: {
      begin() {
        const ac = new AbortController();
        activeAbort = ac;
        return ac.signal;
      },
      end() {
        activeAbort = null;
      },
    },

    abortIfRunning() {
      const ac = activeAbort;
      if (!ac) {
        return false;
      }
      activeAbort = null;
      ac.abort();
      return true;
    },
  };
}
