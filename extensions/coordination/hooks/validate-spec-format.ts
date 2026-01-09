/**
 * Output validation hook: Validate TASK-XX spec format.
 *
 * This extension validates that the structuring phase output follows
 * the TASK-XX spec format with required fields:
 * - Valid task IDs (TASK-XX pattern)
 * - Files field
 * - Depends on field
 * - Acceptance criteria
 *
 * Configuration via environment variable:
 *   PI_VALIDATE_SPEC_MAX_RETRIES=3  (default: 2)
 *
 * Usage in agent frontmatter:
 * ```yaml
 * ---
 * name: coordination/structurer
 * extensions: ../hooks/validate-spec-format.ts
 * ---
 * ```
 *
 * @module
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Maximum retry attempts. Override via PI_VALIDATE_SPEC_MAX_RETRIES env var. */
const MAX_RETRIES = (() => {
	const val = parseInt(process.env.PI_VALIDATE_SPEC_MAX_RETRIES || "2", 10);
	return Number.isNaN(val) ? 2 : val;
})();

/** Regex for valid task IDs: TASK-XX, TASK-XX.Y, DISC-XX, FIX-XX */
const TASK_ID_PATTERN = /^(TASK-\d{2,}(\.\d+)?|DISC-\d{2,}|FIX-\d{2,})$/;

interface SpecValidation {
	valid: boolean;
	errors: string[];
	warnings: string[];
	taskCount: number;
}

interface ParsedTask {
	id: string;
	title: string;
	hasFiles: boolean;
	hasDependsOn: boolean;
	hasAcceptance: boolean;
	dependsOn: string[];
}

/**
 * Extract text content from agent messages.
 */
function extractTextFromMessages(messages: unknown[]): string {
	const textParts: string[] = [];

	for (const msg of messages) {
		const m = msg as { role?: string; content?: unknown };
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content) {
				const b = block as { type?: string; text?: string };
				if (b.type === "text" && b.text) {
					textParts.push(b.text);
				}
			}
		}
	}

	return textParts.join("\n");
}

/**
 * Parse task sections from spec text.
 */
function parseTasks(text: string): ParsedTask[] {
	const tasks: ParsedTask[] = [];

	// Match task headers: ## TASK-XX: Title
	const taskHeaderPattern = /^##\s+(TASK-\d{2,}(?:\.\d+)?|DISC-\d{2,}|FIX-\d{2,}):\s*(.+)$/gm;
	const sections = text.split(/(?=^##\s+(?:TASK-|DISC-|FIX-)\d)/m);

	for (const section of sections) {
		const headerMatch = section.match(/^##\s+(TASK-\d{2,}(?:\.\d+)?|DISC-\d{2,}|FIX-\d{2,}):\s*(.+)$/m);
		if (!headerMatch) continue;

		const id = headerMatch[1];
		const title = headerMatch[2].trim();

		// Check for required fields in section
		const hasFiles = /files?:/i.test(section);
		const hasDependsOn = /depends\s+on:/i.test(section);
		const hasAcceptance = /acceptance:/i.test(section);

		// Extract dependencies
		const dependsOnMatch = section.match(/depends\s+on:\s*(.+)/i);
		let dependsOn: string[] = [];
		if (dependsOnMatch) {
			const depText = dependsOnMatch[1].trim().toLowerCase();
			if (depText !== "none" && depText !== "-") {
				// Parse comma-separated or newline-separated deps
				dependsOn = depText
					.split(/[,\n]/)
					.map((d) => d.trim().toUpperCase())
					.filter((d) => TASK_ID_PATTERN.test(d));
			}
		}

		tasks.push({
			id,
			title,
			hasFiles,
			hasDependsOn,
			hasAcceptance,
			dependsOn,
		});
	}

	return tasks;
}

/**
 * Detect circular dependencies.
 */
function detectCycles(tasks: ParsedTask[]): string[] {
	const cycles: string[] = [];
	const taskMap = new Map(tasks.map((t) => [t.id, t]));

	function hasCycleDFS(taskId: string, visited: Set<string>, stack: Set<string>): boolean {
		if (stack.has(taskId)) return true;
		if (visited.has(taskId)) return false;

		visited.add(taskId);
		stack.add(taskId);

		const task = taskMap.get(taskId);
		if (task) {
			for (const dep of task.dependsOn) {
				if (hasCycleDFS(dep, visited, stack)) {
					cycles.push(`${taskId} -> ${dep}`);
					return true;
				}
			}
		}

		stack.delete(taskId);
		return false;
	}

	for (const task of tasks) {
		hasCycleDFS(task.id, new Set(), new Set());
	}

	return cycles;
}

/**
 * Validate spec format.
 */
function validateSpecText(text: string): SpecValidation {
	const errors: string[] = [];
	const warnings: string[] = [];

	const tasks = parseTasks(text);

	// Check: At least one task
	if (tasks.length === 0) {
		errors.push("No TASK-XX sections found");
		return { valid: false, errors, warnings, taskCount: 0 };
	}

	// Check each task
	const taskIds = new Set(tasks.map((t) => t.id));

	for (const task of tasks) {
		// Validate task ID format
		if (!TASK_ID_PATTERN.test(task.id)) {
			errors.push(`Invalid task ID: ${task.id} (expected TASK-XX or TASK-XX.Y)`);
		}

		// Check required fields
		if (!task.hasFiles) {
			warnings.push(`${task.id} missing Files field`);
		}
		if (!task.hasDependsOn) {
			warnings.push(`${task.id} missing "Depends on" field`);
		}
		if (!task.hasAcceptance) {
			warnings.push(`${task.id} missing Acceptance field`);
		}

		// Check dependencies reference existing tasks
		for (const dep of task.dependsOn) {
			if (!taskIds.has(dep)) {
				errors.push(`${task.id} depends on non-existent ${dep}`);
			}
		}
	}

	// Check: At least one entry point (task with no dependencies)
	const entryPoints = tasks.filter((t) => t.dependsOn.length === 0);
	if (entryPoints.length === 0) {
		errors.push("No entry point task (all tasks have dependencies)");
	}

	// Check: No circular dependencies
	const cycles = detectCycles(tasks);
	if (cycles.length > 0) {
		errors.push(`Circular dependencies detected: ${cycles.join(", ")}`);
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		taskCount: tasks.length,
	};
}

export default function validateSpecFormat(pi: ExtensionAPI): void {
	let retryCount = 0;

	pi.on("agent_end", async (event, ctx) => {
		const text = extractTextFromMessages(event.messages);
		const validation = validateSpecText(text);

		if (validation.valid) {
			// Log warnings even on success
			if (validation.warnings.length > 0) {
				console.log(`[validate-spec-format] ${validation.taskCount} tasks, warnings: ${validation.warnings.join("; ")}`);
			}
			retryCount = 0;
			return;
		}

		// Invalid format - retry if under limit
		if (retryCount < MAX_RETRIES) {
			retryCount++;
			console.log(`[validate-spec-format] Errors: ${validation.errors.join("; ")}, retry ${retryCount}/${MAX_RETRIES}`);

			pi.sendMessage(
				{
					customType: "validate-spec-format-retry",
					content: `Your spec output has formatting errors:

**Errors:**
${validation.errors.map((e) => `- ${e}`).join("\n")}

${validation.warnings.length > 0 ? `**Warnings:**\n${validation.warnings.map((w) => `- ${w}`).join("\n")}` : ""}

Please fix these issues and output a valid spec with:
- Task headers: ## TASK-XX: Title
- Required fields: Files, Depends on, Acceptance
- At least one task with "Depends on: none" as entry point
- No circular dependencies

Attempt ${retryCount}/${MAX_RETRIES}.`,
					display: false,
				},
				{ triggerTurn: true }
			);
		} else {
			// Max retries exceeded
			console.warn(`[validate-spec-format] Max retries (${MAX_RETRIES}) exceeded, giving up`);
			retryCount = 0;
		}
	});

	// Reset retry count at the start of each agent run
	pi.on("agent_start", () => {
		retryCount = 0;
	});
}
