/**
 * Compiler feedback loop: auto-repair for coordination workers.
 *
 * After a worker completes a task, run tsc + tests against the project. If
 * either fails, feed the error output back to a new repair worker and retry
 * up to `maxRetries` times before escalating to human review.
 *
 * Published baseline: 39% → 96% task success rate with 3-retry loop.
 */

import * as fsSync from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface RepairContext {
	/** Task identifier for logging (e.g. "TASK-02") */
	taskId: string;
	/** The worker's final output text (used in logs, not sent to repair worker) */
	workerOutput: string;
	/** Original handshake spec given to the worker — included in repair prompt */
	originalHandshakeSpec: string;
	/** Files the worker reported as modified — checked for .ts/.tsx to decide if tsc is needed */
	filesModified: string[];
	/** Coordination session directory */
	coordDir: string;
	/** Project root to run tsc / npm test from */
	cwd: string;
	/** Maximum repair cycles before giving up (default: 3) */
	maxRetries?: number;
	/**
	 * Callback to spawn a repair worker with the given prompt.
	 * The caller is responsible for creating the worker process.
	 * Returns the exit code and any additional files the repair worker modified.
	 */
	spawnRepairWorker: (prompt: string) => Promise<{ exitCode: number; filesModified: string[] }>;
	/**
	 * Optional callback to update worker repair state for display purposes.
	 * Called before each repair attempt so the dashboard can show "auto-repair N/3".
	 */
	onRepairAttempt?: (attempt: number, maxAttempts: number) => Promise<void> | void;
}

export interface RepairResult {
	success: boolean;
	/** Number of verification + repair cycles that ran (0 if verification not applicable) */
	attempts: number;
	/** Error output from the last failed verification (present when success=false) */
	finalError?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

interface VerificationResult {
	passed: boolean;
	output: string;
}

/**
 * Run `npx tsc --noEmit` (if tsconfig present) then
 * `npm run test --if-present` (if package.json present).
 * Returns { passed, output } — output contains compiler/test errors on failure.
 */
async function runVerification(cwd: string): Promise<VerificationResult> {
	const outputs: string[] = [];
	const hasTsConfig = fsSync.existsSync(path.join(cwd, "tsconfig.json"));
	const hasPackageJson = fsSync.existsSync(path.join(cwd, "package.json"));

	if (!hasTsConfig && !hasPackageJson) {
		return { passed: true, output: "" };
	}

	// ── TypeScript check ───────────────────────────────────────────────────
	if (hasTsConfig) {
		try {
			await execAsync("npx tsc --noEmit 2>&1", { cwd, timeout: 60_000 });
		} catch (err: unknown) {
			const e = err as { stdout?: string; stderr?: string; message?: string };
			const raw = ((e.stdout ?? "") + (e.stderr ?? "") + (e.message ?? "")).trim();
			outputs.push(`TypeScript errors:\n${raw}`);
			// Return early — no point running tests if tsc fails
			return { passed: false, output: outputs.join("\n\n") };
		}
	}

	// ── Test suite ─────────────────────────────────────────────────────────
	if (hasPackageJson) {
		try {
			const { stdout, stderr } = await execAsync(
				"npm run test --if-present 2>&1 | head -100",
				{ cwd, timeout: 120_000, shell: "/bin/sh" },
			);
			const combined = (stdout + stderr).trim();
			// Heuristic: treat non-empty stderr or failure keywords as test failure
			if (stderr.trim() || /\bFAIL\b|\bfailed\b|\bError\b/i.test(combined)) {
				const limited = combined.split("\n").slice(0, 100).join("\n");
				outputs.push(`Test failures:\n${limited}`);
				return { passed: false, output: outputs.join("\n\n") };
			}
		} catch (err: unknown) {
			const e = err as { stdout?: string; stderr?: string; message?: string };
			const rawOutput = ((e.stdout ?? "") + (e.stderr ?? "") + (e.message ?? "")).trim();
			const limited = rawOutput.split("\n").slice(0, 100).join("\n");
			outputs.push(`Test failures:\n${limited}`);
			return { passed: false, output: outputs.join("\n\n") };
		}
	}

	return { passed: true, output: "" };
}

/**
 * Build the compact repair prompt shown to the repair worker.
 */
function buildRepairPrompt(
	attempt: number,
	maxRetries: number,
	originalHandshakeSpec: string,
	filesModified: string[],
	errorOutput: string,
): string {
	// Truncate error output to at most 200 lines to stay within context limits
	const truncatedError = errorOutput.split("\n").slice(0, 200).join("\n");

	const fileList = filesModified.length > 0
		? filesModified.map(f => `- ${f}`).join("\n")
		: "- (no files reported)";

	return `## Auto-Repair Attempt ${attempt}/${maxRetries}

Your previous implementation has errors. Fix them.

### Original Task:
${originalHandshakeSpec}

### Files you modified:
${fileList}

### Errors:
\`\`\`
${truncatedError}
\`\`\`

Fix ALL errors. Do not explain — just fix.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the compiler feedback loop for a completed worker task.
 *
 * Algorithm:
 *  1. Skip entirely if no TypeScript files were modified AND no tsconfig/package.json exist.
 *  2. Run `npx tsc --noEmit` then `npm run test --if-present`.
 *  3. If both pass → return { success: true, attempts: 1 }.
 *  4. If either fails → build repair prompt, call ctx.spawnRepairWorker(), repeat.
 *  5. After maxRetries failures → return { success: false, attempts: N, finalError }.
 */
export async function runAutoRepair(ctx: RepairContext): Promise<RepairResult> {
	const maxRetries = ctx.maxRetries ?? 3;

	// Decide whether to run verification at all
	const hasTypeScriptFiles = ctx.filesModified.some(
		f => f.endsWith(".ts") || f.endsWith(".tsx"),
	);
	const hasTsConfig = fsSync.existsSync(path.join(ctx.cwd, "tsconfig.json"));
	const hasPackageJson = fsSync.existsSync(path.join(ctx.cwd, "package.json"));

	if (!hasTypeScriptFiles && !hasTsConfig && !hasPackageJson) {
		// Nothing to verify — treat as pass without consuming an attempt slot
		return { success: true, attempts: 0 };
	}

	let lastError = "";

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const verification = await runVerification(ctx.cwd);

		if (verification.passed) {
			return { success: true, attempts: attempt };
		}

		lastError = verification.output;

		const errLineCount = verification.output.split("\n").filter(l => l.trim()).length;
		console.log(
			`[auto-repair] ${ctx.taskId}: attempt ${attempt}/${maxRetries} — ${errLineCount} error line(s) remaining`,
		);

		// Don't spawn another worker on the last attempt (we already know it failed)
		if (attempt === maxRetries) {
			break;
		}

		// Notify caller that repair is starting (for dashboard display)
		if (ctx.onRepairAttempt) {
			await ctx.onRepairAttempt(attempt, maxRetries);
		}

		const repairPrompt = buildRepairPrompt(
			attempt,
			maxRetries,
			ctx.originalHandshakeSpec,
			ctx.filesModified,
			verification.output,
		);

		try {
			const repairResult = await ctx.spawnRepairWorker(repairPrompt);

			// Merge any new files the repair worker touched
			for (const f of repairResult.filesModified) {
				if (!ctx.filesModified.includes(f)) {
					ctx.filesModified.push(f);
				}
			}
		} catch (err) {
			console.error(`[auto-repair] ${ctx.taskId}: repair worker error: ${err}`);
			// Continue to the next verification attempt anyway
		}
	}

	return {
		success: false,
		attempts: maxRetries,
		finalError: lastError,
	};
}
