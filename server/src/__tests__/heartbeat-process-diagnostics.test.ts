import { describe, expect, it } from "vitest";
import { buildHeartbeatRunProcessDiagnostics } from "../services/heartbeat.ts";

describe("heartbeat run process diagnostics", () => {
  it("surfaces when the child process predates the run record", () => {
    const diagnostic = buildHeartbeatRunProcessDiagnostics({
      processStartedAt: new Date("2026-05-05T10:30:00.000Z"),
      startedAt: new Date("2026-05-05T14:35:00.000Z"),
    });

    expect(diagnostic).toMatchObject({
      processStartedBeforeRun: true,
      processStartedBeforeRunByMs: 4 * 60 * 60 * 1000 + 5 * 60 * 1000,
    });
  });

  it("does not flag fresh processes", () => {
    const diagnostic = buildHeartbeatRunProcessDiagnostics({
      processStartedAt: new Date("2026-05-05T14:35:00.000Z"),
      startedAt: new Date("2026-05-05T14:35:00.000Z"),
    });

    expect(diagnostic).toMatchObject({
      processStartedBeforeRun: false,
      processStartedBeforeRunByMs: 0,
    });
  });
});
