/**
 * hitl-gate.ts — Human-In-The-Loop approval gate
 *
 * Writes an approval-request file and polls for an approval-response file.
 * If `hitl` is set to 'off', the gate is skipped entirely (always approved).
 * Default timeout: 5 minutes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type HitlMode = "off" | "on" | "auto";

export interface HitlGateOptions {
	/** Coordination session directory */
	coordDir: string;
	/** Identifier for the approval request (e.g. task ID or phase name) */
	taskId: string;
	/** Human-readable summary of what is being approved */
	summary: string;
	/** HITL mode — 'off' skips the gate entirely */
	hitl?: HitlMode;
	/** Poll timeout in milliseconds (default: 5 minutes) */
	timeoutMs?: number;
	/** Poll interval in milliseconds (default: 2 seconds) */
	pollIntervalMs?: number;
}

export interface ApprovalRequest {
	taskId: string;
	summary: string;
	requestedAt: number;
}

export interface ApprovalResponse {
	taskId: string;
	approved: boolean;
	comment?: string;
	respondedAt: number;
}

/**
 * Request human approval for the given task.
 *
 * Returns `true` if approved (or if hitl is 'off'), `false` if denied or timed out.
 */
export async function requestApproval(opts: HitlGateOptions): Promise<boolean> {
	const {
		coordDir,
		taskId,
		summary,
		hitl = "auto",
		timeoutMs = 5 * 60 * 1000,
		pollIntervalMs = 2000,
	} = opts;

	// If HITL is explicitly off, skip the gate entirely — always approved.
	if (hitl === "off") {
		return true;
	}

	const hitlDir = path.join(coordDir, "hitl");
	await fs.mkdir(hitlDir, { recursive: true });

	// Write the approval-request file so an external agent/human can action it.
	const requestPath = path.join(hitlDir, `${taskId}-approval-request.json`);
	const request: ApprovalRequest = {
		taskId,
		summary,
		requestedAt: Date.now(),
	};
	await fs.writeFile(requestPath, JSON.stringify(request, null, 2), "utf-8");

	// Poll for the approval-response file.
	const responsePath = path.join(hitlDir, `${taskId}-approval-response.json`);
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const responseData = await fs.readFile(responsePath, "utf-8");
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
		`Denying — no human response received within timeout.`
	);
	return false;
}

// ── Compatibility layer for coordinate/index.ts ─────────────────
// coordinate/index.ts imports checkGate + HITLMode from the old API.
// This wrapper adapts the old call signature to the new requestApproval API.

export type HITLMode = "strict" | "permissive" | "off";

/**
 * Compatibility wrapper for the old checkGate API.
 * Called by coordinate/index.ts to gate high-stakes tasks.
 *
 * In 'off' mode: never holds.
 * In 'permissive' mode: only holds critical-pattern tasks (delete/drop/migrate/deploy/security).
 * In 'strict' mode: holds all tasks for approval.
 */
export async function checkGate(
  taskId: string,
  _role: string,
  description: string,
  coordDir: string,
  hitlMode: HITLMode,
): Promise<{ held: boolean }> {
  if (hitlMode === "off") {
    return { held: false };
  }

  // In permissive mode, only gate tasks with critical patterns
  if (hitlMode === "permissive") {
    const isCritical = /\b(delete|drop|migrate|deploy|security|production|database|auth)\b/i.test(description);
    if (!isCritical) {
      return { held: false };
    }
  }

  // In strict mode (or permissive + critical task), request approval
  const approved = await requestApproval({
    coordDir,
    taskId,
    summary: description,
    hitl: "on",
    timeoutMs: 30_000,
  });

  return { held: !approved };
}
