export const SESSIONED_LOCAL_ADAPTER_TYPES = [
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
] as const;

const SESSIONED_LOCAL_ADAPTERS = new Set<string>(SESSIONED_LOCAL_ADAPTER_TYPES);

export function isTrackedLocalChildProcessAdapter(adapterType: string | null | undefined) {
  return typeof adapterType === "string" && SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

function positiveInteger(value: number | null | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function isRecordedLocalChildProcessAlive(input: {
  processPid: number | null | undefined;
  processGroupId: number | null | undefined;
  isProcessAlive: (pid: number) => boolean;
  isProcessGroupAlive: (processGroupId: number) => boolean;
}) {
  const processGroupId = positiveInteger(input.processGroupId);
  if (processGroupId !== null) return input.isProcessGroupAlive(processGroupId);

  const processPid = positiveInteger(input.processPid);
  if (processPid !== null) return input.isProcessAlive(processPid);

  return false;
}

export const DETACHED_PROCESS_ACTIVITY_CLEARED_MESSAGE =
  "Detached child process reported activity; cleared detached warning";
