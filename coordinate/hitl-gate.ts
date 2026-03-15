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
