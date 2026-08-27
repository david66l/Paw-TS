import type { DerivedDecisionV1, InputFactV1 } from "@paw/protocol";
import type { LoopInputPort, Session } from "../src/index.js";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class MemorySession implements Session<InputFactV1, DerivedDecisionV1> {
  readonly inputFacts: InputFactV1[] = [];
  readonly inputEntries: Array<{
    readonly seq: number;
    readonly fact: InputFactV1;
  }> = [];
  readonly appendBatches: InputFactV1[][] = [];
  readonly derivedDecisions: DerivedDecisionV1[] = [];
  readonly trace: string[];
  private journalSeq = 0;
  private inputThroughSeq = 0;
  private latestRecord:
    | { readonly kind: "input_fact" }
    | {
        readonly kind: "derived_decision";
        readonly decision: DerivedDecisionV1;
      }
    | undefined;
  failInputAppend?: (facts: readonly InputFactV1[]) => Error | undefined;
  beforeCommit?: (
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
  ) => void | Promise<void>;
  beforeDecisionAndInputCommit?: (
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
    facts: readonly InputFactV1[],
  ) => void | Promise<void>;

  constructor(trace: string[] = []) {
    this.trace = trace;
  }

  async readInputSnapshot(): Promise<{
    readonly entries: readonly {
      readonly seq: number;
      readonly fact: InputFactV1;
    }[];
    readonly tailSeq: number;
    readonly latestInputSeq: number;
  }> {
    return {
      entries: [...this.inputEntries],
      tailSeq: this.journalSeq,
      latestInputSeq: this.inputThroughSeq,
    };
  }

  async appendInputFacts(facts: readonly InputFactV1[]): Promise<void> {
    const failure = this.failInputAppend?.(facts);
    if (failure) throw failure;
    this.appendCommittedFacts(facts);
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    if (this.journalSeq !== expectedTailSeq) return "conflict";
    await this.appendInputFacts(facts);
    return "committed";
  }

  private appendCommittedFacts(facts: readonly InputFactV1[]): void {
    this.appendBatches.push([...facts]);
    for (const fact of facts) {
      this.journalSeq += 1;
      this.inputThroughSeq = this.journalSeq;
      this.latestRecord = { kind: "input_fact" };
      this.inputEntries.push({ seq: this.journalSeq, fact });
      this.trace.push(factTrace(fact));
    }
    this.inputFacts.push(...facts);
  }

  async commitDerivedDecision(
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
  ): Promise<"committed" | "conflict"> {
    await this.beforeCommit?.(expectedTailSeq, decision);
    if (this.journalSeq !== expectedTailSeq) {
      this.trace.push(`derived-conflict:${expectedTailSeq}:${this.journalSeq}`);
      return "conflict";
    }
    if (this.latestRecord?.kind === "derived_decision") {
      if (sameDecision(this.latestRecord.decision, decision)) {
        this.trace.push(`derived-idempotent:${decision.action.kind}`);
        return "committed";
      }
      throw new Error(
        "Canonical journal tail has a conflicting derived decision",
      );
    }
    this.journalSeq += 1;
    this.trace.push(`derived:${decision.action.kind}`);
    const storedDecision = cloneDecision(decision);
    this.derivedDecisions.push(storedDecision);
    this.latestRecord = { kind: "derived_decision", decision: storedDecision };
    return "committed";
  }

  async commitDecisionAndInputFacts(
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    await this.beforeDecisionAndInputCommit?.(expectedTailSeq, decision, facts);
    if (this.journalSeq !== expectedTailSeq) {
      this.trace.push(
        `decision-input-conflict:${expectedTailSeq}:${this.journalSeq}`,
      );
      return "conflict";
    }
    if (this.latestRecord?.kind === "derived_decision") {
      throw new Error(
        "Canonical journal tail cannot append a consecutive derived decision",
      );
    }
    const failure = this.failInputAppend?.(facts);
    if (failure) throw failure;

    // 从观察者角度，决定与整批输入只会一起出现或一起失败。
    this.journalSeq += 1;
    this.trace.push(`derived:${decision.action.kind}`);
    const storedDecision = cloneDecision(decision);
    this.derivedDecisions.push(storedDecision);
    this.latestRecord = { kind: "derived_decision", decision: storedDecision };
    this.appendCommittedFacts(facts);
    return "committed";
  }
}

function sameDecision(
  left: DerivedDecisionV1,
  right: DerivedDecisionV1,
): boolean {
  return sameJson(left, right);
}

function cloneDecision(decision: DerivedDecisionV1): DerivedDecisionV1 {
  return deepFreeze(JSON.parse(JSON.stringify(decision)) as DerivedDecisionV1);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameJson(leftRecord[key], rightRecord[key]),
    )
  );
}

export class MemoryLoopInput implements LoopInputPort {
  readonly boundaries: string[] = [];
  readonly trace: string[];
  readonly promotedBatches: string[][];

  constructor(
    promotedBatches: readonly (readonly string[])[] = [],
    trace: string[] = [],
  ) {
    this.promotedBatches = promotedBatches.map((batch) => [...batch]);
    this.trace = trace;
  }

  async reportSafeBoundary(boundary: string): Promise<void> {
    this.boundaries.push(boundary);
    this.trace.push(`boundary:${boundary}`);
  }

  async consumePromotedInputIds(): Promise<readonly string[]> {
    const promoted = this.promotedBatches.shift() ?? [];
    this.trace.push(`promoted:${promoted.length}`);
    return promoted;
  }
}

function factTrace(fact: InputFactV1): string {
  if (fact.type === "tool.dispatch_recorded") {
    return `append:${fact.type}:${fact.callId}`;
  }
  if (fact.type === "tool.settled") {
    return `append:${fact.type}:${fact.callId}:${fact.status}`;
  }
  if (fact.type === "model.dispatch_recorded") {
    return `append:${fact.type}:${fact.turn}`;
  }
  if (fact.type === "model.settled") {
    return `append:${fact.type}:${fact.turn}:${fact.status}`;
  }
  return `append:${fact.type}`;
}
