/**
 * Worker Context Persistence
 *
 * Maintains a persistent context file for each task that survives worker restarts.
 * The context tracks:
 * - Files modified (with success/partial/failed status)
 * - Discoveries made during work
 * - Attempt history (workers, exit codes, reasons)
 * - Last actions before failure
 * - Continuation notes for smart restarts
 *
 * Context is auto-updated by hooking into tool events, and is used by
 * auto-continue.ts to build intelligent continuation prompts.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

/**
 * File modification status.
 */
export type FileStatus = "complete" | "partial" | "failed";

/**
 * Tracked file modification.
 */
export interface FileModification {
	file: string;
	action: "created" | "modified" | "deleted";
	status: FileStatus;
	errorLine?: number;
	errorMessage?: string;
	timestamp: number;
}

/**
 * Progress item (checklist).
 */
export interface ProgressItem {
	description: string;
	complete: boolean;
	timestamp?: number;
}

/**
 * Attempt record.
 */
export interface AttemptRecord {
	attempt: number;
	workerId: string;
	workerIdentity: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	exitReason?: string;
}

/**
 * Action record for tracking recent tool calls.
 */
export interface ActionRecord {
	timestamp: number;
	tool: string;
	target?: string;
	result: "success" | "error";
	errorMessage?: string;
}

/**
 * Full worker context state.
 */
export interface WorkerContext {
	taskId: string;
	taskTitle?: string;
	taskDescription?: string;
	progress: ProgressItem[];
	filesModified: FileModification[];
	discoveries: string[];
	attempts: AttemptRecord[];
	lastActions: ActionRecord[];
	continuationNotes: string[];
	updatedAt: number;
}

/**
 * Context updater returned by createContextUpdater().
 */
export interface ContextUpdater {
	/** Track a tool result event. */
	onToolResult(event: ToolResultEvent): void;
	/** Record a discovery. */
	onDiscovery(topic: string, content: string): void;
	/** Record progress update. */
	onProgress(description: string, complete: boolean): void;
	/** Handle worker exit. */
	onWorkerEnd(exitCode: number, exitReason?: string): void;
	/** Get current context. */
	getContext(): WorkerContext;
	/** Save context to disk. */
	save(): Promise<void>;
	/** Save context synchronously. */
	saveSync(): void;
}

/**
 * Tool result event shape.
 */
export interface ToolResultEvent {
	toolName: string;
	input?: {
		path?: string;
		file?: string;
		command?: string;
		[key: string]: unknown;
	};
	isError?: boolean;
	result?: unknown;
	errorMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Path Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the workers directory for a coordination session.
 */
export function getWorkersDir(coordDir: string): string {
	return path.join(coordDir, "workers");
}

/**
 * Get the directory for a specific task's worker context.
 */
export function getTaskContextDir(coordDir: string, taskId: string): string {
	return path.join(getWorkersDir(coordDir), taskId);
}

/**
 * Get the path to a task's context.md file.
 */
export function getContextPath(coordDir: string, taskId: string): string {
	return path.join(getTaskContextDir(coordDir, taskId), "context.md");
}

/**
 * Get the path to a task's attempt state file.
 */
export function getAttemptPath(coordDir: string, taskId: string, attempt: number): string {
	const paddedAttempt = attempt.toString().padStart(3, "0");
	return path.join(getTaskContextDir(coordDir, taskId), `attempt-${paddedAttempt}.json`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Loading and Saving
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load context from disk, or create a fresh context if none exists.
 */
export async function loadContext(coordDir: string, taskId: string): Promise<WorkerContext> {
	const contextPath = getContextPath(coordDir, taskId);

	try {
		const content = await fs.readFile(contextPath, "utf-8");
		return parseContextFromMarkdown(content, taskId);
	} catch {
		// No existing context - create fresh
		return createFreshContext(taskId);
	}
}

/**
 * Load context synchronously.
 */
export function loadContextSync(coordDir: string, taskId: string): WorkerContext {
	const contextPath = getContextPath(coordDir, taskId);

	try {
		const content = fsSync.readFileSync(contextPath, "utf-8");
		return parseContextFromMarkdown(content, taskId);
	} catch {
		return createFreshContext(taskId);
	}
}

/**
 * Save context to disk.
 */
export async function saveContext(
	coordDir: string,
	taskId: string,
	context: WorkerContext,
): Promise<void> {
	const contextDir = getTaskContextDir(coordDir, taskId);
	const contextPath = getContextPath(coordDir, taskId);

	await fs.mkdir(contextDir, { recursive: true });
	await fs.writeFile(contextPath, renderContextToMarkdown(context), "utf-8");
}

/**
 * Save context synchronously (for use in event handlers).
 */
export function saveContextSync(
	coordDir: string,
	taskId: string,
	context: WorkerContext,
): void {
	const contextDir = getTaskContextDir(coordDir, taskId);
	const contextPath = getContextPath(coordDir, taskId);

	try {
		fsSync.mkdirSync(contextDir, { recursive: true });
	} catch {}
	fsSync.writeFileSync(contextPath, renderContextToMarkdown(context), "utf-8");
}

/**
 * Create a fresh context for a task.
 */
export function createFreshContext(taskId: string): WorkerContext {
	return {
		taskId,
		progress: [],
		filesModified: [],
		discoveries: [],
		attempts: [],
		lastActions: [],
		continuationNotes: [],
		updatedAt: Date.now(),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Updater Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a context updater for tracking worker activity.
 *
 * The updater hooks into tool events and maintains the context.md file.
 * It auto-saves on significant events (file modifications, errors, discoveries).
 */
export function createContextUpdater(
	coordDir: string,
	taskId: string,
	workerId: string,
	workerIdentity: string,
): ContextUpdater {
	let context = loadContextSync(coordDir, taskId);

	// Start a new attempt
	const attemptNumber = context.attempts.length + 1;
	context.attempts.push({
		attempt: attemptNumber,
		workerId,
		workerIdentity,
		startedAt: Date.now(),
	});

	// Auto-save on creation
	saveContextSync(coordDir, taskId, context);

	const save = async () => {
		context.updatedAt = Date.now();
		await saveContext(coordDir, taskId, context);
	};

	const saveSync = () => {
		context.updatedAt = Date.now();
		saveContextSync(coordDir, taskId, context);
	};

	return {
		onToolResult(event: ToolResultEvent) {
			const toolName = event.toolName;
			const input = event.input || {};

			// Track file modifications from edit/write tools
			if (toolName === "edit" || toolName === "write") {
				const filePath = input.path || input.file;
				if (typeof filePath === "string") {
					const existing = context.filesModified.find((f) => f.file === filePath);

					if (existing) {
						existing.status = event.isError ? "failed" : "complete";
						existing.timestamp = Date.now();
						if (event.isError && event.errorMessage) {
							existing.errorMessage = event.errorMessage;
							// Try to extract line number from error message
							const lineMatch = event.errorMessage.match(/line[:\s]+(\d+)/i);
							if (lineMatch) {
								existing.errorLine = parseInt(lineMatch[1], 10);
							}
						}
					} else {
						context.filesModified.push({
							file: filePath,
							action: toolName === "write" ? "created" : "modified",
							status: event.isError ? "failed" : "complete",
							timestamp: Date.now(),
							...(event.isError && event.errorMessage
								? { errorMessage: event.errorMessage }
								: {}),
						});
					}
				}
			}

			// Track recent actions
			const target = extractTarget(toolName, input);
			context.lastActions.unshift({
				timestamp: Date.now(),
				tool: toolName,
				target,
				result: event.isError ? "error" : "success",
				errorMessage: event.isError ? event.errorMessage : undefined,
			});

			// Keep only last 20 actions
			if (context.lastActions.length > 20) {
				context.lastActions = context.lastActions.slice(0, 20);
			}

			// Auto-save on file modifications or errors
			if (toolName === "edit" || toolName === "write" || event.isError) {
				saveSync();
			}
		},

		onDiscovery(topic: string, content: string) {
			const discovery = `${topic}: ${content}`;
			if (!context.discoveries.includes(discovery)) {
				context.discoveries.push(discovery);
				saveSync();
			}
		},

		onProgress(description: string, complete: boolean) {
			const existing = context.progress.find((p) => p.description === description);
			if (existing) {
				existing.complete = complete;
				existing.timestamp = Date.now();
			} else {
				context.progress.push({
					description,
					complete,
					timestamp: Date.now(),
				});
			}
			saveSync();
		},

		onWorkerEnd(exitCode: number, exitReason?: string) {
			const currentAttempt = context.attempts[context.attempts.length - 1];
			if (currentAttempt) {
				currentAttempt.endedAt = Date.now();
				currentAttempt.exitCode = exitCode;
				currentAttempt.exitReason = exitReason || inferExitReason(exitCode);
			}

			// Generate continuation notes on failure
			if (exitCode !== 0) {
				context.continuationNotes = generateContinuationNotes(context);
			}

			saveSync();

			// Also save attempt state as JSON for detailed analysis
			const attemptPath = getAttemptPath(coordDir, taskId, currentAttempt?.attempt || 1);
			try {
				fsSync.writeFileSync(
					attemptPath,
					JSON.stringify(
						{
							...currentAttempt,
							filesModified: context.filesModified,
							lastActions: context.lastActions.slice(0, 10),
							discoveries: context.discoveries,
						},
						null,
						2,
					),
					"utf-8",
				);
			} catch {}
		},

		getContext() {
			return context;
		},

		save,
		saveSync,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Continuation Notes Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate continuation notes based on context analysis.
 */
export function generateContinuationNotes(context: WorkerContext): string[] {
	const notes: string[] = [];

	// Note completed files (don't recreate)
	const completedFiles = context.filesModified.filter((f) => f.status === "complete");
	if (completedFiles.length > 0) {
		notes.push(`Don't recreate: ${completedFiles.map((f) => f.file).join(", ")}`);
	}

	// Note failed files with errors
	const failedFiles = context.filesModified.filter((f) => f.status === "failed");
	for (const f of failedFiles) {
		const location = f.errorLine ? `:${f.errorLine}` : "";
		const error = f.errorMessage || "unknown error";
		notes.push(`Fix ${f.file}${location}: ${error.slice(0, 100)}`);
	}

	// Note partial files
	const partialFiles = context.filesModified.filter((f) => f.status === "partial");
	for (const f of partialFiles) {
		notes.push(`Continue editing ${f.file} (partially complete)`);
	}

	// Note last action if it was an error
	const lastAction = context.lastActions[0];
	if (lastAction?.result === "error") {
		notes.push(
			`Last error was in ${lastAction.tool}: ${lastAction.errorMessage?.slice(0, 100) || "unknown"}`,
		);
	}

	return notes;
}

/**
 * Infer failure reason from exit code.
 */
export function inferExitReason(exitCode: number): string {
	switch (exitCode) {
		case 0:
			return "Success";
		case 1:
			return "General error";
		case 42:
			return "Restart requested";
		case 124:
			return "Timeout";
		case 137:
			return "Out of memory (SIGKILL)";
		case 143:
			return "Terminated (SIGTERM)";
		default:
			return `Exit code ${exitCode}`;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render context to markdown format.
 */
export function renderContextToMarkdown(context: WorkerContext): string {
	const lines: string[] = [];

	// Header
	lines.push(`# Task Context: ${context.taskId}`);
	lines.push("");

	if (context.taskTitle) {
		lines.push(`**Title:** ${context.taskTitle}`);
		lines.push("");
	}

	if (context.taskDescription) {
		lines.push("## Description");
		lines.push(context.taskDescription);
		lines.push("");
	}

	// Progress
	if (context.progress.length > 0) {
		lines.push("## Progress");
		for (const item of context.progress) {
			const check = item.complete ? "[x]" : "[ ]";
			lines.push(`- ${check} ${item.description}`);
		}
		lines.push("");
	}

	// Files Modified
	if (context.filesModified.length > 0) {
		lines.push("## Files Modified");
		lines.push("| File | Action | Status |");
		lines.push("|------|--------|--------|");
		for (const f of context.filesModified) {
			const statusIcon =
				f.status === "complete" ? "✓" : f.status === "partial" ? "⚠️" : "✗";
			const errorInfo = f.errorMessage
				? ` (${f.errorLine ? `line ${f.errorLine}: ` : ""}${f.errorMessage.slice(0, 50)})`
				: "";
			lines.push(
				`| ${f.file} | ${f.action} | ${statusIcon} ${f.status}${errorInfo} |`,
			);
		}
		lines.push("");
	}

	// Discoveries
	if (context.discoveries.length > 0) {
		lines.push("## Discoveries");
		for (const d of context.discoveries) {
			lines.push(`- ${d}`);
		}
		lines.push("");
	}

	// Attempts
	if (context.attempts.length > 0) {
		lines.push("## Attempts");
		lines.push("| # | Worker | Started | Ended | Exit | Reason |");
		lines.push("|---|--------|---------|-------|------|--------|");
		for (const a of context.attempts) {
			const started = new Date(a.startedAt).toISOString().slice(11, 19);
			const ended = a.endedAt
				? new Date(a.endedAt).toISOString().slice(11, 19)
				: "active";
			const exit = a.exitCode !== undefined ? String(a.exitCode) : "-";
			const reason = a.exitReason || "-";
			lines.push(
				`| ${a.attempt} | ${a.workerIdentity.slice(0, 20)} | ${started} | ${ended} | ${exit} | ${reason} |`,
			);
		}
		lines.push("");
	}

	// Last Actions
	if (context.lastActions.length > 0) {
		const currentAttempt = context.attempts[context.attempts.length - 1];
		lines.push(`## Last Actions (Attempt ${currentAttempt?.attempt || "?"})`);
		lines.push("```");
		for (const action of context.lastActions.slice(0, 10)) {
			const time = new Date(action.timestamp).toISOString().slice(11, 19);
			const status = action.result === "error" ? "✗" : "✓";
			const target = action.target ? ` ${action.target}` : "";
			lines.push(`${time} ${status} ${action.tool}${target}`);
			if (action.errorMessage) {
				lines.push(`         → ERROR: ${action.errorMessage.slice(0, 80)}`);
			}
		}
		lines.push("```");
		lines.push("");
	}

	// Continuation Notes
	if (context.continuationNotes.length > 0) {
		lines.push("## Continuation Notes");
		for (const note of context.continuationNotes) {
			lines.push(`- ${note}`);
		}
		lines.push("");
	}

	lines.push(`---`);
	lines.push(`*Last updated: ${new Date(context.updatedAt).toISOString()}*`);

	return lines.join("\n");
}

/**
 * Parse context from markdown format.
 */
export function parseContextFromMarkdown(content: string, taskId: string): WorkerContext {
	const context = createFreshContext(taskId);

	// Extract task title
	const titleMatch = content.match(/\*\*Title:\*\*\s*(.+)/);
	if (titleMatch) {
		context.taskTitle = titleMatch[1].trim();
	}

	// Extract progress items
	const progressMatches = content.matchAll(/- \[([ x])\] (.+)/g);
	for (const match of progressMatches) {
		context.progress.push({
			description: match[2].trim(),
			complete: match[1] === "x",
		});
	}

	// Extract files modified (from table)
	const fileMatches = content.matchAll(
		/\| ([^\|]+) \| (created|modified|deleted) \| ([✓⚠️✗]) (\w+)/g,
	);
	for (const match of fileMatches) {
		context.filesModified.push({
			file: match[1].trim(),
			action: match[2].trim() as "created" | "modified" | "deleted",
			status: parseFileStatus(match[4].trim()),
			timestamp: Date.now(),
		});
	}

	// Extract discoveries
	const discoverySection = content.match(/## Discoveries\n([\s\S]*?)(?=\n##|$)/);
	if (discoverySection) {
		const discoveryMatches = discoverySection[1].matchAll(/- (.+)/g);
		for (const match of discoveryMatches) {
			context.discoveries.push(match[1].trim());
		}
	}

	// Extract continuation notes
	const notesSection = content.match(/## Continuation Notes\n([\s\S]*?)(?=\n##|---|$)/);
	if (notesSection) {
		const notesMatches = notesSection[1].matchAll(/- (.+)/g);
		for (const match of notesMatches) {
			context.continuationNotes.push(match[1].trim());
		}
	}

	return context;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function extractTarget(toolName: string, input: Record<string, unknown>): string | undefined {
	if (input.path) return String(input.path);
	if (input.file) return String(input.file);

	if (toolName === "bash" && input.command) {
		const cmd = String(input.command);
		return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
	}

	return undefined;
}

function parseFileStatus(status: string): FileStatus {
	if (status === "complete") return "complete";
	if (status === "partial") return "partial";
	return "failed";
}
