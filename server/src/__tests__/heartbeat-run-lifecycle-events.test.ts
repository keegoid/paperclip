import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter, type ServerAdapterModule } from "../adapters/index.ts";

const lifecycleTestAdapter: ServerAdapterModule = {
  type: "lifecycle_test",
  execute: async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "adapter complete",
    provider: "test",
    model: "test-model",
  }),
  testEnvironment: async () => ({
    adapterType: "lifecycle_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  supportsLocalAgentJwt: false,
};

const lifecycleTimeoutTestAdapter: ServerAdapterModule = {
  type: "lifecycle_timeout_test",
  execute: async () => ({
    exitCode: null,
    signal: null,
    timedOut: true,
    errorMessage: "Timed out",
    summary: "adapter timed out",
    provider: "test",
    model: "test-model",
  }),
  testEnvironment: async () => ({
    adapterType: "lifecycle_timeout_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  supportsLocalAgentJwt: false,
};

let releaseRaceAdapter: (() => void) | null = null;

const lifecycleRaceTestAdapter: ServerAdapterModule = {
  type: "lifecycle_race_test",
  execute: async () => {
    await new Promise<void>((resolve) => {
      releaseRaceAdapter = resolve;
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "completed after cancel",
      usage: {
        inputTokens: 7,
        outputTokens: 11,
      },
      provider: "test",
      model: "test-model",
    };
  },
  testEnvironment: async () => ({
    adapterType: "lifecycle_race_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  supportsLocalAgentJwt: false,
};

const lifecycleFailureRaceTestAdapter: ServerAdapterModule = {
  type: "lifecycle_failure_race_test",
  execute: async ({ onLog }) => {
    await new Promise<void>((resolve) => {
      releaseRaceAdapter = resolve;
    });
    await onLog("stdout", "adapter reached failure race\n");
    throw new Error("failed after cancel");
  },
  testEnvironment: async () => ({
    adapterType: "lifecycle_failure_race_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  supportsLocalAgentJwt: false,
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat lifecycle event tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat run lifecycle events", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    registerServerAdapter(lifecycleTestAdapter);
    registerServerAdapter(lifecycleTimeoutTestAdapter);
    registerServerAdapter(lifecycleRaceTestAdapter);
    registerServerAdapter(lifecycleFailureRaceTestAdapter);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-events-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    releaseRaceAdapter?.();
    releaseRaceAdapter = null;
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter("lifecycle_test");
    unregisterServerAdapter("lifecycle_timeout_test");
    unregisterServerAdapter("lifecycle_race_test");
    unregisterServerAdapter("lifecycle_failure_race_test");
    await tempDb?.cleanup();
  });

  async function waitForRunToSettle(runId: string, timeoutMs = 10_000) {
    const heartbeat = heartbeatService(db);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (!run || (run.status !== "queued" && run.status !== "running")) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return heartbeat.getRun(runId);
  }

  async function waitForActivity(action: string, runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(eq(activityLog.action, action), eq(activityLog.runId, runId)))
        .limit(1);
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${action} activity for run ${runId}`);
  }

  async function waitForRunResult(runId: string, timeoutMs = 10_000) {
    const heartbeat = heartbeatService(db);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run?.resultJson) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return heartbeat.getRun(runId);
  }

  async function waitForRaceAdapterReady(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (releaseRaceAdapter) return releaseRaceAdapter;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for race adapter to start");
  }

  async function waitForRuntimeState(agentId: string, expectedRunId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [runtime] = await db
        .select()
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId));
      if (runtime?.lastRunId === expectedRunId) return runtime;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    return runtime ?? null;
  }

  it("activity-logs started run lifecycle events for plugin subscribers", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "lifecycle_test",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "queued",
      contextSnapshot: {},
    });

    await heartbeatService(db).resumeQueuedRuns();

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.run.started"))
      .orderBy(desc(activityLog.createdAt));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "agent.run.started",
      entityType: "run",
      entityId: runId,
      agentId,
      runId,
    });
    expect(rows[0]?.details).toMatchObject({
      runId,
      agentId,
      status: "running",
      previousStatus: "queued",
      invocationSource: "assignment",
      triggerDetail: "manual",
    });

    const settled = await waitForRunToSettle(runId);
    expect(settled?.status).toBe("succeeded");
    await waitForActivity("agent.run.finished", runId);
  });

  it("activity-logs timed out runs as failed events with timeout details", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TimeoutAgent",
      role: "engineer",
      status: "running",
      adapterType: "lifecycle_timeout_test",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "queued",
      contextSnapshot: {},
    });

    await heartbeatService(db).resumeQueuedRuns();
    const settled = await waitForRunToSettle(runId);

    expect(settled?.status).toBe("timed_out");
    await waitForActivity("agent.run.failed", runId);

    const rows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "agent.run.failed"), eq(activityLog.runId, runId)));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toMatchObject({
      runId,
      agentId,
      status: "timed_out",
      previousStatus: "running",
      error: "Timed out",
      errorCode: "timeout",
    });
  });

  it("activity-logs cancelled run lifecycle events for plugin subscribers", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "lifecycle_test",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "test",
      triggerDetail: "manual",
      status: "claimed",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "running",
      startedAt: new Date("2026-04-28T00:00:00.000Z"),
      wakeupRequestId,
      contextSnapshot: {},
      usageJson: {
        input_tokens: 10,
        outputTokens: 20,
        total_cost_usd: 0.12,
        rawPayload: "x".repeat(10_000),
      },
      resultJson: {
        summary: "run summary",
        nestedHuge: { ignored: true },
      },
    });

    const heartbeat = heartbeatService(db);
    await Promise.all([
      heartbeat.cancelRun(runId),
      heartbeat.cancelRun(runId),
    ]);

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.run.cancelled"))
      .orderBy(desc(activityLog.createdAt));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "agent.run.cancelled",
      entityType: "run",
      entityId: runId,
      agentId,
      runId,
    });
    expect(rows[0]?.details).toMatchObject({
      runId,
      agentId,
      status: "cancelled",
      previousStatus: "running",
      invocationSource: "assignment",
      triggerDetail: "manual",
      errorCode: "cancelled",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.12,
      },
      result: {
        summary: "run summary",
      },
    });
    expect(rows[0]?.details?.usage).not.toHaveProperty("rawPayload");
    expect(rows[0]?.details?.result).not.toHaveProperty("nestedHuge");

    await expect(db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "agent.run.cancelled",
      entityType: "run",
      entityId: runId,
      agentId,
      runId,
    })).rejects.toMatchObject({ code: "23505" });

    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(wakeup?.status).toBe("cancelled");
  });

  it("preserves adapter artifacts when cancellation wins the finalization race", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RaceAgent",
      role: "engineer",
      status: "running",
      adapterType: "lifecycle_race_test",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "queued",
      contextSnapshot: {},
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await waitForActivity("agent.run.started", runId);
    const release = await waitForRaceAdapterReady();

    await heartbeat.cancelRun(runId);
    release();
    releaseRaceAdapter = null;

    const run = await waitForRunResult(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.resultJson).toMatchObject({ summary: "completed after cancel" });

    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime).toMatchObject({
      lastRunId: runId,
      lastRunStatus: "cancelled",
      totalInputTokens: 7,
      totalOutputTokens: 11,
    });
  }, 15_000);

  it("updates runtime bookkeeping when cancellation wins an adapter failure race", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FailureRaceAgent",
      role: "engineer",
      status: "running",
      adapterType: "lifecycle_failure_race_test",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "queued",
      contextSnapshot: {},
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await waitForActivity("agent.run.started", runId);
    const release = await waitForRaceAdapterReady();

    await heartbeat.cancelRun(runId);
    release();
    releaseRaceAdapter = null;

    const runtime = await waitForRuntimeState(agentId, runId);
    expect(runtime).toMatchObject({
      lastRunId: runId,
      lastRunStatus: "cancelled",
      lastError: "failed after cancel",
    });

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.stdoutExcerpt).toContain("adapter reached failure race");

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent?.status).toBe("idle");
  }, 15_000);
});
