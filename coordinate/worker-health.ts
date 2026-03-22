/**
 * Worker Health State — TASK-20
 *
 * Pure functions for computing 4-state visual health indicators.
 * No TUI dependency — fully testable.
 *
 * States:
 *   active   — working, heartbeat recent    → cyan  ▶
 *   stale    — working, heartbeat silent    → amber ⚠
 *   blocked  — blocked/waiting              → red   ✗
 *   complete — done                         → green ✓
 */

export type WorkerVisualState = "active" | "stale" | "blocked" | "complete" | "pending" | "failed";

export interface WorkerHealthResult {
  state: WorkerVisualState;
  icon: string;
  colorHint: "cyan" | "amber" | "red" | "green" | "muted" | "dim";
  staleSinceMs: number;
  label: string;
}

export const STALE_THRESHOLD_MS = 60_000;

export const FEYNMAN_MAP: Record<string, string> = {
  worker: "Dyson",
  scout: "Arline",
  planner: "Wheeler",
  reviewer: "Murray",
  verifier: "Hans",
  auditor: "Dirac",
  researcher: "Tukey",
};

/**
 * Compute the visual health state for a worker.
 *
 * @param status — WorkerStatus from WorkerStateFile
 * @param lastHeartbeatAt — timestamp of last heartbeat (ms), or undefined
 * @param startedAt — timestamp worker started (ms), or undefined
 * @param nowMs — current time (injectable for testing)
 */
export function getWorkerVisualState(
  status: string,
  lastHeartbeatAt: number | undefined,
  startedAt: number | undefined,
  nowMs = Date.now(),
): WorkerHealthResult {
  const activityTs = lastHeartbeatAt ?? startedAt;
  const staleSinceMs = activityTs ? nowMs - activityTs : 0;
  const isStale = status === "working" && staleSinceMs > STALE_THRESHOLD_MS;

  switch (status) {
    case "complete":
      return { state: "complete", icon: "✓", colorHint: "green",  staleSinceMs, label: "complete" };
    case "failed":
      return { state: "failed",   icon: "✗", colorHint: "red",    staleSinceMs, label: "failed" };
    case "blocked":
    case "waiting":
      return { state: "blocked",  icon: "✗", colorHint: "red",    staleSinceMs, label: status };
    case "working":
      if (isStale) {
        return { state: "stale",  icon: "⚠", colorHint: "amber",  staleSinceMs, label: "stale" };
      }
      return { state: "active",   icon: "▶", colorHint: "cyan",   staleSinceMs, label: "active" };
    default:
      return { state: "pending",  icon: "○", colorHint: "dim",    staleSinceMs, label: status };
  }
}

/**
 * Render a worker card line in the format:
 *   [Dyson · worker] Task-N: <title> [████░░░░░░] 50%
 */
export function renderWorkerCard(opts: {
  agentType: string;
  feynmanRole?: string;
  taskId?: string;
  taskTitle?: string;
  completedSteps: number;
  totalSteps: number;
  status: string;
  lastHeartbeatAt?: number;
  startedAt?: number;
  nowMs?: number;
  barWidth?: number;
}): string {
  const {
    agentType = "worker",
    feynmanRole,
    taskId = "?",
    taskTitle = "",
    completedSteps,
    totalSteps,
    status,
    lastHeartbeatAt,
    startedAt,
    nowMs = Date.now(),
    barWidth = 10,
  } = opts;

  const normalized = agentType.toLowerCase().replace(/-.*/, "");
  const feynman = feynmanRole ?? FEYNMAN_MAP[normalized] ?? agentType;
  const badge = `[${feynman} · ${normalized}]`;

  const health = getWorkerVisualState(status, lastHeartbeatAt, startedAt, nowMs);

  const total = Math.max(totalSteps, 1);
  const pct = Math.min(100, Math.round((completedSteps / total) * 100));
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = `[${"█".repeat(filled)}${"░".repeat(empty)}] ${pct}%`;

  const titlePart = taskTitle ? `: ${taskTitle}` : "";
  return `${badge} ${health.icon} ${taskId}${titlePart} ${bar}`;
}
