/**
 * hitl-gate.ts — Human-In-The-Loop approval gate
 *
 * Writes an approval-request file and polls for an approval-response file.
 * If `hitl` is set to 'off', the gate is skipped entirely (always approved).
 *
 * v2 additions:
 *  - Risk scoring engine (`scoreTaskRisk` / `RiskLevel`) — TASK-01
 *  - Risk-based timeouts in `checkGate` — TASK-03
 *  - Callback-first approval path (`onApprovalNeeded`) — TASK-02
 *  - Audit log for all gate decisions (`logAudit`) — TASK-03
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type HitlMode = "off" | "on" | "auto";

// ── Risk scoring ─────────────────────────────────────────────────

/**
 * Four-level risk classification for task descriptions.
 *
 * - `critical`: Destructive verb targeting production/schema/data, or force-push to main/master/prod
 * - `high`:     Dangerous operations (schema migration, deploy-to-prod, delete/force without safe context)
 * - `medium`:   Write operations that modify state but aren't inherently destructive
 * - `low`:      Read-only, analytical, scouting, or purely additive code operations
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Score a task description and return its risk level.
 *
 * Designed to avoid false positives on generic coding operations like
 * "Add reconnect with exponential backoff" (→ low) while correctly
 * flagging "Deploy to production" (→ high/critical).
 */
export function scoreTaskRisk(description: string): RiskLevel {
  const d = description.toLowerCase();

  // ── CRITICAL ────────────────────────────────────────────────────
  // Destructive verb + production/schema/data target (combined context)
  if (
    /\b(delete|drop|destroy|purge|wipe)\b.*\b(prod|production|schema|data|table|database)\b/i.test(d) ||
    /\b(force[- ]push|rm\s+-rf)\b.*\b(main|master|prod)/i.test(d)
  ) {
    return 'critical';
  }
  // Phrase-level critical patterns
  if (/\b(delete all|drop table|truncate|wipe.*data|purge.*schema)\b/i.test(d)) {
    return 'critical';
  }

  // ── HIGH ─────────────────────────────────────────────────────────
  // Schema migrations, deploy-to-prod, bare force-push / rm -rf / truncate
  if (
    /\b(migrate\s+schema|deploy\s+(to\s+)?prod(uction)?|force[- ]push|rm\s+-rf|drop\s+table|truncate)\b/i.test(d)
  ) {
    return 'high';
  }
  // delete / force-push without a "safe" qualifier (read/scout/analyze/review/check/inspect)
  if (
    /\b(delete|force[- ]push)\b/i.test(d) &&
    !/\b(read|scout|analyze|review|check|inspect)\b/i.test(d)
  ) {
    return 'high';
  }

  // ── LOW (checked BEFORE medium to avoid false positives) ─────────
  // Read-only, analytical, scouting, or audit operations
  if (
    /\b(scout|review|analyze|analyse|read|inspect|check|audit|report|list|show|search|find|explore|understand|map|trace|query|look)\b/i.test(d)
  ) {
    // Destructive override: safe qualifiers (review, inspect, etc.) do NOT neutralise
    // explicitly destructive operations. "review and delete schema" is still high-risk.
    if (/\b(delete|drop|destroy|purge|wipe|rm\s+-rf|force.push|migrate.*schema)\b/i.test(d)) {
      return 'high';
    }
    return 'low';
  }

  // ── MEDIUM ───────────────────────────────────────────────────────
  // Unambiguous write/deploy/migrate operations
  if (
    /\b(deploy|migrate|modify|update|install|upgrade|refactor|move|rename)\b/i.test(d)
  ) {
    return 'medium';
  }
  // create/add/implement/build ONLY escalate to medium when paired with an
  // infrastructure-flavoured target.  Generic additive coding ("add backoff
  // logic", "create shared client") stays LOW.
  if (
    /\b(create|add|implement|build)\b.*\b(endpoint|api|route|service|server|integration|plugin|feature|module|component|interface)\b/i.test(d)
  ) {
    return 'medium';
  }

  // Default: low-risk additive / read-adjacent work
  return 'low';
}

// ── Non-blocking score-and-collect (BUG-01 fix) ──────────────────

/**
 * Score a task's risk WITHOUT blocking on human approval.
 *
 * Use this to assemble the full batch of gated tasks before writing a single
 * batch-approval-request.json. Replaces the old pattern of calling checkGate()
 * per-task inside a loop, which caused per-task blocking before the batch was
 * ever assembled.
 */
export function scoreAndCollect(
  taskId: string,
  description: string,
): { taskId: string; risk: RiskLevel; shouldGate: boolean } {
  const risk = scoreTaskRisk(description);
  return { taskId, risk, shouldGate: risk !== 'low' };
}

// ── Audit logging ─────────────────────────────────────────────────

/**
 * Append a structured audit entry to `coordDir/hitl/audit.jsonl`.
 *
 * Called for every gate decision — including auto-approved LOW risk tasks —
 * so there is a full record of all activity regardless of whether a human
 * approval was requested.
 */
export async function logAudit(
  coordDir: string,
  taskId: string,
  agentId: string,
  description: string,
  decision: 'auto-approved' | 'approved' | 'denied' | 'timeout',
  risk: RiskLevel,
): Promise<void> {
  try {
    const auditDir = path.join(coordDir, 'hitl');
    await fs.mkdir(auditDir, { recursive: true });
    const entry = {
      taskId,
      agentId,
      description,
      decision,
      risk,
      timestamp: Date.now(),
    };
    await fs.appendFile(
      path.join(auditDir, 'audit.jsonl'),
      JSON.stringify(entry) + '\n',
      'utf-8',
    );
  } catch (err) {
    // Audit failures must never block task execution.
    console.warn('[hitl-gate] audit log write failed:', err);
  }
}

// ── Types ─────────────────────────────────────────────────────────

/**
 * Structured approval request passed to the `onApprovalNeeded` callback.
 * Exported so `coordinate/index.ts` (TASK-04) can type-check callback implementations.
 */
export interface ApprovalRequest {
  taskId: string;
  /** Agent or role that triggered the approval request (e.g. 'coordinator'). */
  agentId: string;
  summary: string;
  /** Computed risk level for the task — lets the callback surface risk to the user. */
  risk: RiskLevel;
  requestedAt: number;
}

export interface HitlGateOptions {
  /** Coordination session directory */
  coordDir: string;
  /** Identifier for the approval request (e.g. task ID or phase name) */
  taskId: string;
  /** Agent or role requesting approval (e.g. 'coordinator', 'worker-A') */
  agentId?: string;
  /** Human-readable summary of what is being approved */
  summary: string;
  /** HITL mode — 'off' skips the gate entirely */
  hitl?: HitlMode;
  /**
   * Poll timeout in milliseconds.
   * @deprecated Use risk-based timeouts via checkGate instead.
   * Kept for back-compat — still honoured when requestApproval is called directly.
   * Default: 5 minutes.
   */
  timeoutMs?: number;
  /** Poll interval in milliseconds (default: 2 seconds) */
  pollIntervalMs?: number;
  /**
   * Mesh-native approval callback (TASK-02).
   *
   * When provided, `requestApproval` will call this first with a structured
   * `ApprovalRequest` and await the result.  This is the hook for the
   * `coordinate()` tool (or any orchestrator) to surface the approval via
   * pi_messenger, an interview prompt, or any other interactive surface.
   *
   * If the callback throws or rejects, `requestApproval` falls through to the
   * traditional file-polling mechanism so headless/CI environments continue to work.
   */
  onApprovalNeeded?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface ApprovalResponse {
  taskId: string;
  approved: boolean;
  comment?: string;
  respondedAt: number;
}

// ── Core approval function ────────────────────────────────────────

/**
 * Request human approval for the given task.
 *
 * Approval resolution order (TASK-02):
 *   1. `onApprovalNeeded` callback — mesh-native path (pi_messenger, interview, TUI)
 *   2. File-polling fallback — legacy / headless / CI path
 *   3. Timeout deny — no response within `timeoutMs`
 *
 * Returns `true` if approved (or if hitl is 'off'), `false` if denied or timed out.
 */
export async function requestApproval(opts: HitlGateOptions): Promise<boolean> {
  const {
    coordDir,
    taskId,
    agentId = 'coordinator',
    summary,
    hitl = 'auto',
    timeoutMs = 5 * 60 * 1000,
    pollIntervalMs = 2000,
    onApprovalNeeded,
  } = opts;

  // If HITL is explicitly off, skip the gate entirely — always approved.
  if (hitl === 'off') {
    return true;
  }

  const risk = scoreTaskRisk(summary);

  // ── Path 1: Callback-based (mesh-native) approval ────────────────
  // The caller (e.g. coordinate/index.ts) provides a callback that can surface
  // the approval via pi_messenger, an interview prompt, or any interactive UX.
  if (onApprovalNeeded) {
    try {
      const request: ApprovalRequest = { taskId, agentId, summary, risk, requestedAt: Date.now() };
      const approved = await Promise.race([
        onApprovalNeeded(request),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
      return approved;
    } catch (err) {
      // Callback failed — fall through to file-polling so CI/headless keeps working.
      console.warn('[hitl-gate] onApprovalNeeded callback failed, falling back to file-polling:', err);
    }
  }

  // ── Path 2: File-polling (legacy / CI fallback) ───────────────────
  const hitlDir = path.join(coordDir, 'hitl');
  await fs.mkdir(hitlDir, { recursive: true });

  const requestPath = path.join(hitlDir, `${taskId}-approval-request.json`);
  const request: ApprovalRequest = { taskId, agentId, summary, risk, requestedAt: Date.now() };
  await fs.writeFile(requestPath, JSON.stringify(request, null, 2), 'utf-8');

  const responsePath = path.join(hitlDir, `${taskId}-approval-response.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const responseData = await fs.readFile(responsePath, 'utf-8');
      const response = JSON.parse(responseData) as ApprovalResponse;
      return response.approved;
    } catch {
      // Response not yet written — keep polling.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Timed out without a response.
  console.warn(
    `[hitl-gate] Approval request for task "${taskId}" timed out after ${timeoutMs / 1000}s. ` +
    `Denying — no human response received within timeout.`,
  );
  return false;
}

// ── Compatibility layer for coordinate/index.ts ─────────────────
// coordinate/index.ts imports checkGate + HITLMode from the old API.
// This wrapper adapts the old call signature to the new requestApproval API.

export type HITLMode = 'strict' | 'permissive' | 'off';

/** Risk-based timeout map (milliseconds) */
export const RISK_TIMEOUTS: Record<RiskLevel, number> = {
  critical: 5 * 60_000,  // 5 minutes — must wait for human
  high:     3 * 60_000,  // 3 minutes
  medium:   2 * 60_000,  // 2 minutes
  low:      0,           // auto-approve, audit only
};

/**
 * Compatibility wrapper for the old checkGate API.
 * Called by coordinate/index.ts to gate high-stakes tasks.
 *
 * v2 behaviour (TASK-02 + TASK-03):
 * - Uses `scoreTaskRisk()` for risk classification.
 * - Uses `RISK_TIMEOUTS` — no hardcoded 30_000 anywhere.
 * - Calls `logAudit()` for every decision (including auto-approved LOW tasks).
 * - Passes `onApprovalNeeded` callback to `requestApproval` (mesh-native path).
 *
 * Mode routing:
 * - 'off':        never holds
 * - 'permissive': gates HIGH + CRITICAL only (low/medium auto-pass)
 * - 'strict':     gates MEDIUM + HIGH + CRITICAL (low auto-passes)
 *
 * LOW risk always returns immediately with `auditOnly: true`.
 */
export async function checkGate(
  taskId: string,
  agentId: string,
  description: string,
  coordDir: string,
  hitlMode: HITLMode,
  onApprovalNeeded?: (request: ApprovalRequest) => Promise<boolean>,
): Promise<{ held: boolean; risk?: RiskLevel; auditOnly?: boolean }> {
  if (hitlMode === 'off') {
    return { held: false };
  }

  const risk = scoreTaskRisk(description);

  // LOW never gates in any mode — audit-only path.
  if (risk === 'low') {
    await logAudit(coordDir, taskId, agentId, description, 'auto-approved', risk);
    return { held: false, risk: 'low', auditOnly: true };
  }

  // Determine whether this risk level triggers gating for the selected mode.
  const shouldGate =
    hitlMode === 'strict'
      ? risk === 'medium' || risk === 'high' || risk === 'critical'
      : /* permissive */ risk === 'high' || risk === 'critical';

  if (!shouldGate) {
    // Medium in permissive mode — passes without approval.
    await logAudit(coordDir, taskId, agentId, description, 'auto-approved', risk);
    return { held: false, risk };
  }

  // Gate: request approval via risk-appropriate timeout.
  const timeoutMs = RISK_TIMEOUTS[risk];
  const approved = await requestApproval({
    coordDir,
    taskId,
    agentId,
    summary: description,
    hitl: 'on',
    timeoutMs,
    onApprovalNeeded,
  });

  const decision = approved ? 'approved' : 'denied';
  await logAudit(coordDir, taskId, agentId, description, decision, risk);

  return { held: !approved, risk };
}

// ── Recap compatibility ──────────────────────────────────────────

export interface HITLSummary {
  gatesTriggered: number;
  approved: number;
  rejected: number;
  pending: number;
}

/**
 * Summarize HITL gate activity for recap generation.
 * Scans the hitl/ directory for request and response files.
 */
export async function getHITLSummary(coordDir: string, _mode: HITLMode): Promise<HITLSummary> {
  const hitlDir = path.join(coordDir, 'hitl');
  const summary: HITLSummary = {
    gatesTriggered: 0,
    approved: 0,
    rejected: 0,
    pending: 0,
  };

  try {
    const files = await fs.readdir(hitlDir);
    const requests = files.filter(f => f.endsWith('-approval-request.json'));
    summary.gatesTriggered = requests.length;

    for (const reqFile of requests) {
      const taskId = reqFile.replace('-approval-request.json', '');
      const respFile = `${taskId}-approval-response.json`;

      if (files.includes(respFile)) {
        const respData = await fs.readFile(path.join(hitlDir, respFile), 'utf-8');
        let resp: ApprovalResponse;
        try {
          resp = JSON.parse(respData) as ApprovalResponse;
        } catch {
          summary.pending++;
          continue;
        }
        if (resp.approved === true) {
          summary.approved++;
        } else if (resp.approved === false) {
          summary.rejected++;
        } else {
          summary.pending++;
        }
      } else {
        summary.pending++;
      }
    }
  } catch {
    // hitl directory doesn't exist — no gates triggered.
  }

  return summary;
}
