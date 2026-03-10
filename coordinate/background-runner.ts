/**
 * background-runner.ts
 *
 * Enables overnight / fire-and-forget coordination runs.
 * Spawns coordinate() in a detached child process so the user can
 * close the terminal and come back to results.
 *
 * Layout:
 *   ~/.pi/runs/{id}/status.json   — machine-readable status
 *   ~/.pi/runs/{id}/run.log       — full stdout / stderr from the run
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Root directory that holds all background run state
const RUNS_DIR = path.join(os.homedir(), ".pi", "runs");

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface BackgroundRun {
	id: string;            // UUID short (first 8 chars): 'abc12345'
	specPath: string;
	startedAt: string;     // ISO-8601
	status: "running" | "complete" | "failed" | "paused";
	pid?: number;
	logPath: string;       // ~/.pi/runs/{id}/run.log
	statusPath: string;    // ~/.pi/runs/{id}/status.json
	cost?: number;
	completedAt?: string;  // ISO-8601
	error?: string;
}

export interface CoordinateOptions {
	background?: boolean;
	agents?: string[] | number;
	logPath?: string;
	resume?: boolean | string;
	maxFixCycles?: number;
	sameIssueLimit?: number;
	checkTests?: boolean;
	costLimit?: number;
	validate?: boolean;
	validateStream?: boolean;
	coordinator?: string | { model?: string };
	worker?: string | { model?: string };
	reviewer?: string | { model?: string };
	reviewCycles?: number | false;
	supervisor?: boolean | object;
	maxOutput?: { bytes?: number; lines?: number };
	asyncResultsDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function shortId(uuid: string): string {
	return uuid.replace(/-/g, "").slice(0, 8);
}

function runDir(id: string): string {
	return path.join(RUNS_DIR, id);
}

function statusPath(id: string): string {
	return path.join(runDir(id), "status.json");
}

function logPath(id: string): string {
	return path.join(runDir(id), "run.log");
}

async function readStatus(id: string): Promise<BackgroundRun | null> {
	try {
		const raw = await fs.readFile(statusPath(id), "utf-8");
		return JSON.parse(raw) as BackgroundRun;
	} catch {
		return null;
	}
}

async function writeStatus(run: BackgroundRun): Promise<void> {
	const dir = runDir(run.id);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(statusPath(run.id), JSON.stringify(run, null, 2), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn a detached coordinate() child process and return immediately.
 *
 * The child process writes status.json updates as it progresses and calls
 * notifyOnComplete() when the run finishes.
 */
export async function startBackgroundRun(
	specPath: string,
	options: CoordinateOptions = {},
	cwd: string = process.cwd(),
): Promise<BackgroundRun> {
	// Resolve jiti CLI path so we can run TypeScript in the child
	let jitiCliPath: string | undefined;
	try {
		jitiCliPath = path.join(
			path.dirname(require.resolve("jiti/package.json")),
			"lib",
			"jiti-cli.mjs",
		);
	} catch {
		throw new Error("Background runs require jiti (jiti package not found)");
	}

	const id = shortId(randomUUID());
	const dir = runDir(id);
	await fs.mkdir(dir, { recursive: true });

	const log = logPath(id);
	const status = statusPath(id);

	const run: BackgroundRun = {
		id,
		specPath,
		startedAt: new Date().toISOString(),
		status: "running",
		logPath: log,
		statusPath: status,
	};

	// Write initial status before spawn so callers can observe "running" state
	await writeStatus(run);

	// Config file the background runner reads
	const cfgPath = path.join(os.tmpdir(), `pi-bg-run-${id}.json`);
	const cfg = {
		runId: id,
		specPath,
		options: { ...options, background: false },
		cwd,
		statusPath: status,
		logPath: log,
	};
	await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");

	// Spawn the dedicated background entry point
	const runnerScript = path.join(__dirname, "background-run-child.ts");

	const logFd = fsSync.openSync(log, "a");
	const proc = spawn("node", [jitiCliPath, runnerScript, cfgPath], {
		cwd,
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: process.env,
	});

	run.pid = proc.pid;
	await writeStatus(run);

	proc.unref();
	fsSync.closeSync(logFd);

	return run;
}

/**
 * Read current status of a background run.
 */
export async function getRunStatus(runId: string): Promise<BackgroundRun | null> {
	// Accept either the full 8-char ID or a shorter prefix
	if (fsSync.existsSync(runDir(runId))) {
		return readStatus(runId);
	}

	// Try prefix match
	try {
		const entries = await fs.readdir(RUNS_DIR);
		const match = entries.find((e) => e.startsWith(runId));
		if (match) return readStatus(match);
	} catch {
		// RUNS_DIR doesn't exist yet
	}

	return null;
}

/**
 * List all background runs, sorted newest first.
 */
export async function listRuns(): Promise<BackgroundRun[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(RUNS_DIR);
	} catch {
		return [];
	}

	const runs: BackgroundRun[] = [];
	for (const entry of entries) {
		const run = await readStatus(entry);
		if (run) runs.push(run);
	}

	return runs.sort(
		(a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
	);
}

/**
 * Send a macOS notification (or terminal bell fallback) when a run finishes.
 */
export function notifyOnComplete(run: BackgroundRun): void {
	const specName = path.basename(run.specPath, path.extname(run.specPath));
	const statusLabel = run.status === "complete" ? "complete" : "failed";
	const message = `Coordination ${statusLabel}: ${specName}`;

	// macOS notification via osascript
	try {
		const { execSync } = require("node:child_process") as typeof import("node:child_process");
		execSync(
			`osascript -e 'display notification "${message}" with title "pi" sound name "Glass"'`,
			{ stdio: "ignore", timeout: 5000 },
		);
		return;
	} catch {
		// osascript not available (non-macOS or sandbox) — fall through to bell
	}

	// Fallback: terminal bell + log line
	process.stdout.write(`\u0007[pi] ${message}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status-update helpers (used by background-run-child.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark a run as complete (called from inside the child process).
 */
export async function markRunComplete(
	id: string,
	cost?: number,
): Promise<BackgroundRun | null> {
	const run = await readStatus(id);
	if (!run) return null;

	const updated: BackgroundRun = {
		...run,
		status: "complete",
		completedAt: new Date().toISOString(),
		cost,
	};
	await writeStatus(updated);
	notifyOnComplete(updated);
	return updated;
}

/**
 * Mark a run as failed (called from inside the child process).
 */
export async function markRunFailed(
	id: string,
	error: string,
): Promise<BackgroundRun | null> {
	const run = await readStatus(id);
	if (!run) return null;

	const updated: BackgroundRun = {
		...run,
		status: "failed",
		completedAt: new Date().toISOString(),
		error,
	};
	await writeStatus(updated);
	notifyOnComplete(updated);
	return updated;
}

/**
 * Format a BackgroundRun as a human-readable table row.
 */
export function formatRunRow(run: BackgroundRun): string {
	const age = run.completedAt
		? formatAge(new Date(run.completedAt))
		: formatAge(new Date(run.startedAt));
	const statusIcon =
		run.status === "complete" ? "✅" :
		run.status === "failed"   ? "❌" :
		run.status === "paused"   ? "⏸ " : "⏳";
	const costStr = run.cost != null ? `$${run.cost.toFixed(3)}` : "     ";
	const spec = path.basename(run.specPath, path.extname(run.specPath)).slice(0, 30).padEnd(30);
	return `${statusIcon} ${run.id}  ${spec}  ${costStr}  ${age}`;
}

function formatAge(from: Date): string {
	const ms = Date.now() - from.getTime();
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}
