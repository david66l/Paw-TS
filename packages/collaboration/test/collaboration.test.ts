import { describe, expect, test } from "bun:test";
import type { SubAgentLauncher } from "@paw/harness";
import type { InputFactV1 } from "@paw/protocol";
import { createFrozenToolRegistryV1 } from "@paw/runtime";

import {
  DEFAULT_COLLABORATION_POLICY_V1,
  DEFAULT_COLLABORATION_ROSTER_V1,
  createAdaptiveCollaborationLauncherV1,
  createBoundedReadOnlySubAgentLauncherV1,
  createCollaborationChildBoundaryV1,
  createCollaborationRosterV1,
  createCollaborationToolPluginV1,
  createDurableCollaborationCoordinatorV1,
  normalizeCollaborationDelegationV1,
  parseCollaborationAgentSpecV1,
  projectCollaborationTasksV1,
} from "../src/index.js";

describe("collaboration plugin", () => {
  test("derives child authority from AgentSpec rather than semantic scope", () => {
    const verifier = DEFAULT_COLLABORATION_ROSTER_V1.agents.find(
      (agent) => agent.id === "verifier",
    );
    if (!verifier) throw new Error("missing verifier");
    const boundary = createCollaborationChildBoundaryV1({
      agent: verifier,
      sandboxedShell: false,
    });
    expect(boundary).toMatchObject({
      effect: "execute",
      workspaceMode: "shared_readonly",
      shellPolicy: "verification",
      pathPolicy: { readRoots: ["."], writeRoots: [] },
    });
  });

  test("rejects a mission whose reserved child turns exceed the shared budget", () => {
    expect(() =>
      normalizeCollaborationDelegationV1({
        policy: {
          ...DEFAULT_COLLABORATION_POLICY_V1,
          maxChildSteps: 30,
          maxMissionSteps: 30,
        },
        args: {
          goal: "Inspect two subsystems",
          kind: "integration",
          tasks: [
            {
              id: "a",
              goal: "Inspect A",
              kind: "investigation",
              agent_id: "investigator",
            },
            {
              id: "b",
              goal: "Inspect B",
              kind: "review",
              agent_id: "reviewer",
            },
          ],
        },
      }),
    ).toThrow("Mission reserves 60 model turns; maximum is 30");
  });

  test("models inspection, execution, and mutation as distinct effects", () => {
    const verifier = DEFAULT_COLLABORATION_ROSTER_V1.agents.find(
      (agent) => agent.id === "verifier",
    );
    expect(verifier).toMatchObject({
      effect: "execute",
      childPolicy: "read_only",
    });
    expect(verifier?.tools).toContain("workspace.run_shell");
    expect(verifier?.tools).not.toContain("workspace.write_file");

    const legacy = parseCollaborationAgentSpecV1({
      id: "legacy-reader",
      name: "legacy reader",
      role: "investigator",
      description: "read evidence",
      prompt: "Read evidence.",
      outputFormat: "summary",
      capabilities: ["investigation"],
      tools: ["workspace.read_file"],
      childPolicy: "read_only",
      canSpawn: false,
      maxSteps: 4,
    });
    expect(legacy.effect).toBe("inspect");

    expect(() =>
      createCollaborationRosterV1([
        {
          ...legacy,
          effect: "execute",
          childPolicy: "read_write",
        },
      ]),
    ).toThrow("effect conflicts with childPolicy");
  });

  test("publishes the current team and requires explicit agent selection", () => {
    const registry = createFrozenToolRegistryV1({
      plugins: [createCollaborationToolPluginV1()],
    });
    const entry = registry.resolveProviderName("workspace_delegate");
    expect(entry?.internalName).toBe("workspace.run_agent");
    expect(entry?.definition.function.description).toContain(
      "Current Team Brief:",
    );
    expect(entry?.definition.function.description).toContain(
      "agent_id=verifier; specialties=testing; effect=execute; abilities=read,search,git,web,shell,job",
    );
    const omitted = registry.validateAndClassify(
      {
        id: "call-omitted",
        name: "workspace_delegate",
        arguments: {
          goal: "Trace the parser call chain",
          kind: "investigation",
        },
      },
      process.cwd(),
    );
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) expect(omitted.result.summary).toContain("agent_id");
    const validated = registry.validateAndClassify(
      {
        id: "call-1",
        name: "workspace_delegate",
        arguments: {
          goal: "Trace the parser call chain",
          kind: "investigation",
          agent_id: "investigator",
        },
      },
      process.cwd(),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.args.agent_id).toBe("investigator");
    expect(validated.value.args.delegation_plan).toMatchObject({
      mode: "single",
      tasks: [
        {
          capability: "investigation",
          agentId: "investigator",
          initialSteps: 24,
          maxSteps: 56,
        },
      ],
    });
    expect(validated.value.classification.concurrencyMode).toBe("parallel");
    expect(validated.value.classification.lockDomain).toContain(
      "collaboration",
    );

    const reviewer = registry.validateAndClassify(
      {
        id: "call-2",
        name: "workspace_delegate",
        arguments: {
          goal: "Review the parser fix",
          kind: "review",
          agent_id: "reviewer",
        },
      },
      process.cwd(),
    );
    let readerWorkspaceResource: string | undefined;
    expect(reviewer.ok).toBe(true);
    if (reviewer.ok) {
      expect(reviewer.value.args.agent_id).toBe("reviewer");
      expect(reviewer.value.classification.effectClass).toBe("read");
      readerWorkspaceResource = reviewer.value.classification.resources[0]?.key;
    }

    const writerRoster = createCollaborationRosterV1([
      {
        id: "writer",
        name: "writer",
        role: "implementation",
        description: "write code",
        prompt: "Write code.",
        outputFormat: "summary",
        capabilities: ["implementation"],
        tools: ["workspace.read_file", "workspace.write_file"],
        childPolicy: "read_write",
        canSpawn: false,
        maxSteps: 8,
      },
    ]);
    const writerRegistry = createFrozenToolRegistryV1({
      plugins: [createCollaborationToolPluginV1({ roster: writerRoster })],
    });
    expect(
      writerRegistry.resolveProviderName("workspace_delegate")?.definition
        .function.description,
    ).toContain(
      "agent_id=writer; specialties=implementation; effect=mutate; abilities=read,edit",
    );
    const writer = writerRegistry.validateAndClassify(
      {
        id: "call-3",
        name: "workspace_delegate",
        arguments: {
          goal: "Implement the parser fix",
          kind: "implementation",
          agent_id: "writer",
        },
      },
      process.cwd(),
    );
    expect(writer.ok).toBe(true);
    if (writer.ok) {
      expect(writer.value.classification).toMatchObject({
        effectClass: "read",
        permissionCategory: "read",
        concurrencyMode: "parallel",
        resources: [{ access: "write" }],
      });
      expect(writer.value.classification.resources[0]?.key).toBe(
        readerWorkspaceResource,
      );
    }
    const mismatched = writerRegistry.validateAndClassify(
      {
        id: "call-4",
        name: "workspace_delegate",
        arguments: {
          goal: "Investigate the parser",
          kind: "investigation",
          agent_id: "writer",
        },
      },
      process.cwd(),
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.result.summary).toContain(
        "writer does not provide investigation",
      );
    }
  });

  test("validates a mission graph and rejects cycles before execution", () => {
    const registry = createFrozenToolRegistryV1({
      plugins: [createCollaborationToolPluginV1()],
    });
    const valid = registry.validateAndClassify(
      {
        id: "mission",
        name: "workspace_delegate",
        arguments: {
          goal: "Investigate and review the parser",
          kind: "integration",
          tasks: [
            {
              id: "inspect",
              goal: "Trace parser",
              kind: "investigation",
              agent_id: "investigator",
            },
            {
              id: "review",
              goal: "Review evidence",
              kind: "review",
              agent_id: "reviewer",
              depends_on: ["inspect"],
            },
          ],
        },
      },
      process.cwd(),
    );
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.args.delegation_plan).toMatchObject({
        mode: "mission",
        tasks: [
          { id: "inspect", agentId: "investigator" },
          { id: "review", agentId: "reviewer", dependsOn: ["inspect"] },
        ],
      });
    }

    const cyclic = registry.validateAndClassify(
      {
        id: "cycle",
        name: "workspace_delegate",
        arguments: {
          goal: "Cycle",
          kind: "integration",
          tasks: [
            {
              id: "a",
              goal: "A",
              kind: "investigation",
              agent_id: "investigator",
              depends_on: ["b"],
            },
            {
              id: "b",
              goal: "B",
              kind: "review",
              agent_id: "reviewer",
              depends_on: ["a"],
            },
          ],
        },
      },
      process.cwd(),
    );
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) expect(cyclic.result.summary).toContain("cycle");

    const oneTask = registry.validateAndClassify(
      {
        id: "one-task",
        name: "workspace_delegate",
        arguments: {
          goal: "Do one review",
          kind: "review",
          tasks: [
            {
              id: "review",
              goal: "Review once",
              kind: "review",
              agent_id: "reviewer",
            },
          ],
        },
      },
      process.cwd(),
    );
    expect(oneTask.ok).toBe(true);
    if (oneTask.ok) {
      expect(oneTask.value.args.delegation_plan).toMatchObject({
        mode: "single",
        tasks: [{ agentId: "reviewer" }],
      });
    }
  });

  test("runs read tasks in parallel, serializes writers, and honors dependencies", async () => {
    const roster = createCollaborationRosterV1([
      {
        id: "reader",
        name: "reader",
        role: "investigator",
        description: "read evidence",
        prompt: "Read evidence.",
        outputFormat: "summary",
        capabilities: ["investigation"],
        tools: ["workspace.read_file"],
        childPolicy: "read_only",
        canSpawn: false,
        maxSteps: 8,
      },
      {
        id: "writer",
        name: "writer",
        role: "implementation",
        description: "write code",
        prompt: "Write code.",
        outputFormat: "summary",
        capabilities: ["implementation"],
        tools: ["workspace.read_file", "workspace.write_file"],
        childPolicy: "read_write",
        canSpawn: false,
        maxSteps: 8,
      },
    ]);
    const events: string[] = [];
    const goals = new Map<string, string>();
    let activeWriters = 0;
    let maxActiveWriters = 0;
    let activeReaders = 0;
    let maxActiveReaders = 0;
    const delegate: SubAgentLauncher = {
      async launch(goal, _steps, options) {
        const id = options?.agentId ?? "missing";
        const writing = options?.args?.agent_id === "writer";
        events.push(`start:${id}`);
        goals.set(id, goal);
        if (writing) {
          activeWriters += 1;
          maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
        } else {
          activeReaders += 1;
          maxActiveReaders = Math.max(maxActiveReaders, activeReaders);
        }
        await Bun.sleep(goal.startsWith("Inspect") ? 15 : 5);
        if (writing) activeWriters -= 1;
        else activeReaders -= 1;
        events.push(`end:${id}`);
        return { status: "completed", summary: id };
      },
      async launchStreaming(options) {
        return this.launch(options.goal, options.maxSteps, options);
      },
    };
    const launcher = createAdaptiveCollaborationLauncherV1({
      delegate,
      roster,
    });
    const plan = normalizeCollaborationDelegationV1({
      roster,
      args: {
        goal: "Inspect then implement two independent changes",
        kind: "integration",
        tasks: [
          {
            id: "inspect-a",
            goal: "Inspect A",
            kind: "investigation",
            agent_id: "reader",
          },
          {
            id: "inspect-b",
            goal: "Inspect B",
            kind: "investigation",
            agent_id: "reader",
          },
          {
            id: "write-a",
            goal: "Write A",
            kind: "implementation",
            agent_id: "writer",
            depends_on: ["inspect-a", "inspect-b"],
          },
          {
            id: "write-b",
            goal: "Write B",
            kind: "implementation",
            agent_id: "writer",
            depends_on: ["inspect-a", "inspect-b"],
          },
        ],
      },
    });
    const result = await launcher.launch(plan.goal, undefined, {
      parentRunId: "parent",
      agentId: "mission-call",
      args: { delegation_plan: plan },
    });

    expect(result.status).toBe("completed");
    expect(maxActiveReaders).toBe(2);
    expect(maxActiveWriters).toBe(1);
    expect(events.indexOf("end:mission-call:inspect-a")).toBeLessThan(
      events.indexOf("start:mission-call:write-a"),
    );
    expect(events.indexOf("end:mission-call:inspect-b")).toBeLessThan(
      events.indexOf("start:mission-call:write-a"),
    );
    expect(events.indexOf("end:mission-call:write-a")).toBeLessThan(
      events.indexOf("start:mission-call:write-b"),
    );
    expect(goals.get("mission-call:write-a")).toContain(
      "Dependency evidence:\n- inspect-a (completed): mission-call:inspect-a\n- inspect-b (completed): mission-call:inspect-b",
    );
  });

  test("runs verification against a stable workspace and preserves structured evidence", async () => {
    const roster = createCollaborationRosterV1([
      {
        id: "verifier",
        name: "verifier",
        role: "testing",
        description: "run tests",
        prompt: "Run tests.",
        outputFormat: "commands and verdict",
        capabilities: ["testing"],
        tools: ["workspace.read_file", "workspace.run_shell"],
        effect: "execute",
        canSpawn: false,
        maxSteps: 8,
      },
      {
        id: "writer",
        name: "writer",
        role: "implementation",
        description: "write code",
        prompt: "Write code.",
        outputFormat: "summary",
        capabilities: ["implementation"],
        tools: ["workspace.read_file", "workspace.write_file"],
        effect: "mutate",
        canSpawn: false,
        maxSteps: 8,
      },
    ]);
    const events: string[] = [];
    const delegate: SubAgentLauncher = {
      async launch(_goal, _steps, options) {
        const effect =
          options?.args?.agent_id === "verifier" ? "execute" : "mutate";
        events.push(`start:${effect}`);
        await Bun.sleep(5);
        events.push(`end:${effect}`);
        return {
          status: "completed",
          summary: `${effect} completed`,
          outcome: {
            schemaVersion: "paw.sub-agent-outcome.v1",
            effectProfile: effect,
            verdict: effect === "execute" ? "pass" : "not_applicable",
            commands:
              effect === "execute"
                ? [
                    {
                      command: "bun test",
                      exitCode: 0,
                      timedOut: false,
                      passed: true,
                      summary: "1 pass",
                    },
                  ]
                : [],
            artifactRefs: [],
          },
        };
      },
      async launchStreaming(options) {
        return this.launch(options.goal, options.maxSteps, options);
      },
    };
    const launcher = createAdaptiveCollaborationLauncherV1({
      delegate,
      roster,
    });
    const plan = normalizeCollaborationDelegationV1({
      roster,
      args: {
        goal: "Verify and implement independent work",
        kind: "integration",
        tasks: [
          {
            id: "verify",
            goal: "Run tests",
            kind: "testing",
            agent_id: "verifier",
          },
          {
            id: "write",
            goal: "Write code",
            kind: "implementation",
            agent_id: "writer",
          },
        ],
      },
    });

    const result = await launcher.launch(plan.goal, undefined, {
      parentRunId: "parent",
      agentId: "stable-workspace",
      args: { delegation_plan: plan },
    });

    expect(events).toEqual([
      "start:execute",
      "end:execute",
      "start:mutate",
      "end:mutate",
    ]);
    expect(result.outcome).toMatchObject({
      effectProfile: "mixed",
      verdict: "pass",
      commands: [{ command: "bun test", exitCode: 0, passed: true }],
    });
  });

  test("does not launch work whose dependency failed", async () => {
    let launches = 0;
    const delegate: SubAgentLauncher = {
      async launch() {
        launches += 1;
        return { status: "failed", summary: "Investigation failed" };
      },
      async launchStreaming(options) {
        return this.launch(options.goal, options.maxSteps, options);
      },
    };
    const launcher = createAdaptiveCollaborationLauncherV1({ delegate });
    const plan = normalizeCollaborationDelegationV1({
      args: {
        goal: "Investigate then review",
        kind: "review",
        tasks: [
          {
            id: "inspect",
            goal: "Inspect",
            kind: "investigation",
            agent_id: "investigator",
          },
          {
            id: "review",
            goal: "Review",
            kind: "review",
            agent_id: "reviewer",
            depends_on: ["inspect"],
          },
        ],
      },
    });
    const result = await launcher.launch(plan.goal, undefined, {
      parentRunId: "parent",
      agentId: "failed-mission",
      args: { delegation_plan: plan },
    });

    expect(launches).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.findings).toContain(
      "[review/reviewer/failed] Blocked because dependency inspect failed.",
    );
  });

  test("hardens delegate arguments and bounds returned evidence", async () => {
    let seen: Record<string, unknown> | undefined;
    const delegate: SubAgentLauncher = {
      async launch(_goal, _maxSteps, options) {
        seen = options?.args;
        return {
          status: "completed",
          summary: "x".repeat(7_000),
          findings: Array.from(
            { length: 30 },
            (_, index) => `finding-${index}`,
          ),
          changedFiles: ["unexpected.ts"],
        };
      },
      async launchStreaming(options) {
        return this.launch(options.goal, options.maxSteps, options);
      },
    };
    const launcher = createBoundedReadOnlySubAgentLauncherV1({ delegate });
    const result = await launcher.launch("Inspect only", 4, {
      args: { child_policy: "read_write", role: "reviewer" },
    });
    expect(seen?.child_policy).toBe("read_only");
    expect(seen?.agent_id).toBe("reviewer");
    expect(result.summary.length).toBeLessThan(6_100);
    expect(result.findings).toHaveLength(20);
    expect(result.trace).toBeUndefined();
  });

  test("never runs more than three children concurrently", async () => {
    let active = 0;
    let highWater = 0;
    const delegate: SubAgentLauncher = {
      async launch() {
        active += 1;
        highWater = Math.max(highWater, active);
        await Bun.sleep(10);
        active -= 1;
        return { status: "completed", summary: "done" };
      },
      async launchStreaming(options) {
        return this.launch(options.goal, options.maxSteps, options);
      },
    };
    const launcher = createBoundedReadOnlySubAgentLauncherV1({ delegate });
    await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        launcher.launch(`goal-${index}`, 1),
      ),
    );
    expect(highWater).toBe(3);
  });

  test("durably claims and settles a stable child task exactly once", async () => {
    const facts: InputFactV1[] = [];
    let delegateCalls = 0;
    const delegate: SubAgentLauncher = {
      async launch() {
        delegateCalls += 1;
        return { status: "completed", summary: "No regression found." };
      },
      async launchStreaming(options) {
        return this.launch(options.goal, options.maxSteps, options);
      },
    };
    let now = 100;
    const coordinator = createDurableCollaborationCoordinatorV1({
      delegate,
      clock: () => now++,
      journal: {
        readFacts: () => facts,
        async record(next) {
          facts.push(...next);
        },
      },
    });
    const options = {
      parentRunId: "parent-run",
      agentId: "stable-call",
      args: { role: "reviewer" },
    };

    const first = await coordinator.launch(
      "Review the proposed fix",
      4,
      options,
    );
    const second = await coordinator.launch(
      "Review the proposed fix",
      4,
      options,
    );
    const projection = projectCollaborationTasksV1(facts);

    expect(delegateCalls).toBe(2);
    expect(facts.map((fact) => fact.type)).toEqual([
      "runtime.activity_started",
      "runtime.activity_settled",
    ]);
    expect(projection.tasks).toHaveLength(1);
    expect(projection.active).toHaveLength(0);
    expect(projection.tasks[0]?.role).toBe("reviewer");
    expect(first.collaborationTask).toEqual(second.collaborationTask);
    expect(first.collaborationTask).toMatchObject({
      role: "reviewer",
      status: "completed",
    });
  });

  test("rejects reuse of a stable task id with different input", async () => {
    const facts: InputFactV1[] = [];
    const delegate: SubAgentLauncher = {
      async launch() {
        return { status: "completed", summary: "done" };
      },
      async launchStreaming(options) {
        return this.launch(options.goal, options.maxSteps, options);
      },
    };
    const coordinator = createDurableCollaborationCoordinatorV1({
      delegate,
      journal: {
        readFacts: () => facts,
        async record(next) {
          facts.push(...next);
        },
      },
    });
    const identity = { parentRunId: "parent", agentId: "call" };
    await coordinator.launch("Inspect A", 2, identity);

    await expect(coordinator.launch("Inspect B", 2, identity)).rejects.toThrow(
      "reused with different input",
    );
  });

  test("settles a thrown child failure instead of leaving an active task", async () => {
    const facts: InputFactV1[] = [];
    const delegate: SubAgentLauncher = {
      async launch() {
        throw new Error("child transport failed");
      },
      async launchStreaming(options) {
        return this.launch(options.goal, options.maxSteps, options);
      },
    };
    const coordinator = createDurableCollaborationCoordinatorV1({
      delegate,
      journal: {
        readFacts: () => facts,
        async record(next) {
          facts.push(...next);
        },
      },
    });

    await expect(
      coordinator.launch("Inspect failure", 2, {
        parentRunId: "parent",
        agentId: "failed-call",
      }),
    ).rejects.toThrow("child transport failed");
    const projection = projectCollaborationTasksV1(facts);
    expect(projection.active).toHaveLength(0);
    expect(projection.tasks[0]?.settlement).toMatchObject({
      status: "failed",
      summary: "child transport failed",
    });
  });
});
