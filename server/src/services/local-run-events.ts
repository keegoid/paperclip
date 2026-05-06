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

export const DETACHED_PROCESS_ACTIVITY_CLEARED_MESSAGE =
  "Detached child process reported activity; cleared detached warning";
