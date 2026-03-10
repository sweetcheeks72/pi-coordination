/**
 * HITL (Human-in-the-Loop) Permission Gates for pi-coordination.
 *
 * Before workers execute high-stakes actions (git push to production,
 * file deletion, external API writes, DB migrations), this module detects
 * those patterns and provides a gate mechanism requiring human approval.
 *
 * Supports EU AI Act traceability requirements through an append-only
 * HITL decisions audit log.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type HITLMode = "strict" | "permissive" | "off";

export interface HighStakesPattern {
	pattern: RegExp;
	label: string;
	severity: "critical" | "high" | "medium";
	/** Modes that require approval for this pattern */
	requiresApproval: HITLMode[];
}

export interface HITLDecision {
	action: string;
	pattern: string;
	severity: string;
	taskId: string;
	agentId: string;
	decision: "approved" | "rejected" | "modified";
	modifiedAction?: string;
	decidedAt: string;
	decidedBy: "human";
}

export interface HITLGateQuestion {
	taskId: string;
	agentId: string;
	pattern: HighStakesPattern;
	context: string;
	createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern catalogue
// ─────────────────────────────────────────────────────────────────────────────

export const HIGH_STAKES_PATTERNS: HighStakesPattern[] = [
	{
		pattern: /git push.*(?:main|master|production|prod)/i,
		label: "Push to protected branch",
		severity: "critical",
		requiresApproval: ["strict", "permissive"],
	},
	{
		pattern: /DROP TABLE|DROP DATABASE|DELETE FROM.*WHERE/i,
		label: "Destructive DB operation",
		severity: "critical",
		requiresApproval: ["strict", "permissive"],
	},
	{
		pattern: /rm -rf|unlink|fs\.rmSync|fs\.unlinkSync/i,
		label: "File deletion",
		severity: "high",
		requiresApproval: ["strict"],
	},
	{
		pattern: /curl.*-X (POST|PUT|DELETE)|fetch.*method.*(?:POST|PUT|DELETE)/i,
		label: "External API write",
		severity: "high",
		requiresApproval: ["strict"],
	},
	{
		pattern: /npm publish|yarn publish/i,
		label: "Package publish",
		severity: "critical",
		requiresApproval: ["strict", "permissive"],
	},
	{
		pattern: /migrate|migration|flyway|alembic/i,
		label: "Database migration",
		severity: "high",
		requiresApproval: ["strict", "permissive"],
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// Core functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan task content for high-stakes patterns that require approval
 * in the given HITL mode.
 */
export function detectHighStakesActions(
	taskContent: string,
	mode: HITLMode,
): HighStakesPattern[] {
	if (mode === "off") return [];

	return HIGH_STAKES_PATTERNS.filter(
		(p) =>
			p.requiresApproval.includes(mode) && p.pattern.test(taskContent),
	);
}

/**
 * Build a structured gate question in the interview tool question format.
 * The object can be written to {coordDir}/hitl-gate-{taskId}.json and
 * surfaced to the human operator.
 */
export function buildGateQuestion(
	pattern: HighStakesPattern,
	taskId: string,
	agentId: string,
	context: string,
): object {
	const severityEmoji: Record<string, string> = {
		critical: "🔴",
		high: "🟠",
		medium: "🟡",
	};

	return {
		taskId,
		agentId,
		pattern: {
			label: pattern.label,
			severity: pattern.severity,
		},
		context,
		createdAt: new Date().toISOString(),
		// Interview-compatible question format for surfacing in TUI
		question: {
			id: `hitl-${taskId}-${Date.now()}`,
			type: "single",
			question: `${severityEmoji[pattern.severity] ?? "⚠️"} HITL Gate — ${pattern.label} [${pattern.severity.toUpperCase()}]\n\nTask ${taskId} (agent: ${agentId}) wants to perform:\n\n${context}\n\nAllow this action?`,
			options: [
				{ label: "✅ Approve", value: "approved" },
				{ label: "❌ Reject", value: "rejected" },
				{ label: "✏️ Modify (edit action below)", value: "modified" },
			],
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision log (append-only JSONL)
// ─────────────────────────────────────────────────────────────────────────────

const DECISIONS_FILE = "audit/hitl-decisions.jsonl";

/**
 * Append a HITL decision to {coordDir}/audit/hitl-decisions.jsonl.
 * Creates the directory and file if they don't exist.
 */
export async function recordDecision(
	coordDir: string,
	decision: HITLDecision,
): Promise<void> {
	const auditDir = path.join(coordDir, "audit");
	await fs.mkdir(auditDir, { recursive: true });
	const logPath = path.join(coordDir, DECISIONS_FILE);
	const line = JSON.stringify(decision) + "\n";
	await fs.appendFile(logPath, line, "utf-8");
}

/**
 * Read all HITL decisions from {coordDir}/audit/hitl-decisions.jsonl.
 * Returns an empty array if the file doesn't exist.
 */
export async function getDecisions(coordDir: string): Promise<HITLDecision[]> {
	const logPath = path.join(coordDir, DECISIONS_FILE);
	if (!fsSync.existsSync(logPath)) return [];

	const raw = await fs.readFile(logPath, "utf-8");
	const decisions: HITLDecision[] = [];

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			decisions.push(JSON.parse(trimmed) as HITLDecision);
		} catch {
			// Skip malformed lines — log is append-only so we can't fix them
		}
	}

	return decisions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate enforcement helper
// ─────────────────────────────────────────────────────────────────────────────

export interface GateCheckResult {
	/** Whether the task should be held (not dispatched) */
	held: boolean;
	/** Patterns that triggered the gate */
	triggeredPatterns: HighStakesPattern[];
	/** Path to gate question files written (one per pattern) */
	gateFiles: string[];
}

/**
 * Run the full gate check for a task before dispatch.
 *
 * If high-stakes patterns are detected in the given mode:
 * 1. Writes {coordDir}/hitl-gate-{taskId}.json with the gate question.
 * 2. Logs the hold to stdout with the [hitl] prefix.
 * 3. Returns { held: true, triggeredPatterns, gateFiles }.
 *
 * If mode is "off" or no patterns match: returns { held: false, ... }.
 */
export async function checkGate(
	taskId: string,
	agentId: string,
	taskContent: string,
	coordDir: string,
	mode: HITLMode,
): Promise<GateCheckResult> {
	const triggered = detectHighStakesActions(taskContent, mode);

	if (triggered.length === 0) {
		return { held: false, triggeredPatterns: [], gateFiles: [] };
	}

	const gateFiles: string[] = [];

	for (const pattern of triggered) {
		// Extract a short context snippet (first 500 chars of matching area)
		const matchIndex = taskContent.search(pattern.pattern);
		const context =
			matchIndex >= 0
				? taskContent.slice(
						Math.max(0, matchIndex - 100),
						Math.min(taskContent.length, matchIndex + 400),
					)
				: taskContent.slice(0, 500);

		const gateQuestion = buildGateQuestion(pattern, taskId, agentId, context);
		const gateFile = path.join(coordDir, `hitl-gate-${taskId}.json`);
		await fs.writeFile(gateFile, JSON.stringify(gateQuestion, null, 2), "utf-8");
		gateFiles.push(gateFile);

		console.log(
			`[hitl] ⛔ ${taskId} contains: ${pattern.label} — awaiting approval`,
		);
	}

	return { held: true, triggeredPatterns: triggered, gateFiles };
}

/**
 * Get a summary of HITL decisions for a coordination session.
 * Used by the recap generator to build the Governance section.
 */
export interface HITLSummary {
	mode: HITLMode;
	gatesTriggered: number;
	approved: number;
	rejected: number;
	modified: number;
	pending: number;
	logPath: string;
}

export async function getHITLSummary(
	coordDir: string,
	mode: HITLMode,
): Promise<HITLSummary> {
	const decisions = await getDecisions(coordDir);
	const logPath = path.join(coordDir, DECISIONS_FILE);

	// Count pending gates (gate files that have no corresponding decision)
	let pendingGates = 0;
	try {
		const entries = await fs.readdir(coordDir);
		const gateFiles = entries.filter((e) => e.startsWith("hitl-gate-") && e.endsWith(".json"));
		pendingGates = Math.max(0, gateFiles.length - decisions.length);
	} catch {
		// Non-fatal
	}

	const approved = decisions.filter((d) => d.decision === "approved").length;
	const rejected = decisions.filter((d) => d.decision === "rejected").length;
	const modified = decisions.filter((d) => d.decision === "modified").length;

	return {
		mode,
		gatesTriggered: decisions.length + pendingGates,
		approved,
		rejected,
		modified,
		pending: pendingGates,
		logPath,
	};
}
