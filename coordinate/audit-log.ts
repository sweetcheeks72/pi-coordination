/**
 * Immutable audit log for pi-coordination.
 *
 * Each entry is chained to the previous via SHA256(prevHash + eventContent),
 * providing a tamper-evident, append-only JSONL audit trail.
 * Satisfies EU AI Act traceability requirements and supports SOC2 audit workflows.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AuditEventType =
	| "session.start"
	| "session.complete"
	| "session.error"
	| "task.start"
	| "task.complete"
	| "task.failed"
	| "task.repair"
	| "worker.dispatch"
	| "worker.complete"
	| "model.routed"
	| "checkpoint.write"
	| "checkpoint.resume"
	| "hitl.gate"
	| "hitl.approved"
	| "hitl.rejected";

export interface AuditEvent {
	seq: number;               // monotonic sequence number
	ts: string;                // ISO timestamp
	sessionId: string;         // coordination session ID
	type: AuditEventType;      // event type
	agentRole?: string;        // scout, worker, reviewer, etc.
	model?: string;            // model used
	taskId?: string;           // TASK-XX if applicable
	filesModified?: string[];  // files touched
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
	decision?: string;         // human decision if HITL gate
	hash: string;              // SHA256(prevHash + JSON.stringify(event_without_hash))
}

export type AuditEventInput = Omit<AuditEvent, "seq" | "ts" | "hash">;

// ─────────────────────────────────────────────────────────────────────────────
// AuditLog
// ─────────────────────────────────────────────────────────────────────────────

export class AuditLog {
	private logPath: string;
	private seq: number = 0;
	private prevHash: string = "0".repeat(64);

	constructor(coordDir: string, sessionId: string) {
		const auditDir = path.join(coordDir, "audit");
		fs.mkdirSync(auditDir, { recursive: true });
		this.logPath = path.join(auditDir, `${sessionId}.jsonl`);
	}

	/**
	 * Append a new event to the audit log.
	 * Automatically assigns seq, ts, and the chained hash.
	 */
	append(event: AuditEventInput): void {
		const entry: AuditEvent = {
			...event,
			seq: ++this.seq,
			ts: new Date().toISOString(),
			hash: "", // computed below
		};

		// Hash is computed over all fields except `hash` itself
		const { hash: _ignored, ...rest } = entry;
		const content = JSON.stringify(rest);
		entry.hash = createHash("sha256").update(this.prevHash + content).digest("hex");
		this.prevHash = entry.hash;

		fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n");
	}

	/**
	 * Verify the hash chain integrity of the audit log.
	 * Returns { valid: true } if all entries are intact,
	 * or { valid: false, invalidAt: seq } if tampering is detected.
	 */
	verify(): { valid: boolean; invalidAt?: number } {
		if (!fs.existsSync(this.logPath)) return { valid: true };

		const raw = fs.readFileSync(this.logPath, "utf8").trim();
		if (!raw) return { valid: true };

		const lines = raw.split("\n").filter(Boolean);
		let prevHash = "0".repeat(64);

		for (const line of lines) {
			let entry: AuditEvent;
			try {
				entry = JSON.parse(line) as AuditEvent;
			} catch {
				// Malformed line — treat as tampered
				return { valid: false };
			}

			const { hash, ...rest } = entry;
			const content = JSON.stringify(rest);
			const expected = createHash("sha256").update(prevHash + content).digest("hex");

			if (hash !== expected) return { valid: false, invalidAt: entry.seq };
			prevHash = hash;
		}

		return { valid: true };
	}

	/**
	 * Count the number of events in the log.
	 */
	count(): number {
		if (!fs.existsSync(this.logPath)) return 0;
		const raw = fs.readFileSync(this.logPath, "utf8").trim();
		if (!raw) return 0;
		return raw.split("\n").filter(Boolean).length;
	}

	getLogPath(): string {
		return this.logPath;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyAuditLog — exported helper for CLI / `pi audit verify`
// ─────────────────────────────────────────────────────────────────────────────

export async function verifyAuditLog(coordDir: string, sessionId: string): Promise<boolean> {
	const log = new AuditLog(coordDir, sessionId);
	const result = log.verify();
	const count = log.count();

	if (!result.valid) {
		console.error(`[audit] TAMPER DETECTED at sequence ${result.invalidAt}`);
		return false;
	}

	console.log(`[audit] Log verified — ${count} events, hash chain intact`);
	return true;
}
