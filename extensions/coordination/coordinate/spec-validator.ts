/**
 * Spec Validator - Validates spec format and structure.
 *
 * Validation rules:
 * 1. At least one TASK-XX section
 * 2. All task IDs are unique
 * 3. All dependencies reference existing tasks
 * 4. No circular dependencies
 * 5. At least one entry point (task with no dependencies)
 * 6. All required fields present
 * 7. Task IDs match valid patterns
 * 8. Subtasks don't exceed 2 levels (no TASK-XX.Y.Z)
 *
 * @module
 */

import type { Spec, SpecTask, Priority } from "./spec-parser.js";
import { TASK_ID_PATTERNS } from "./spec-parser.js";

/**
 * Validation result from validateSpec().
 */
export interface ValidationResult {
	/** Whether the spec is valid (no errors) */
	valid: boolean;
	/** Critical errors that must be fixed */
	errors: ValidationError[];
	/** Non-critical warnings */
	warnings: ValidationWarning[];
	/** Suggestion for how to fix issues */
	suggestion?: string;
}

/**
 * A validation error.
 */
export interface ValidationError {
	/** Error code */
	code: ValidationErrorCode;
	/** Human-readable message */
	message: string;
	/** Task ID if applicable */
	taskId?: string;
	/** Additional context */
	details?: Record<string, unknown>;
}

/**
 * A validation warning.
 */
export interface ValidationWarning {
	/** Warning code */
	code: ValidationWarningCode;
	/** Human-readable message */
	message: string;
	/** Task ID if applicable */
	taskId?: string;
}

/**
 * Error codes for validation errors.
 */
export type ValidationErrorCode =
	| "NO_TASKS"
	| "INVALID_TASK_ID"
	| "DUPLICATE_TASK_ID"
	| "MISSING_DEPENDENCY"
	| "CIRCULAR_DEPENDENCY"
	| "NO_ENTRY_POINT"
	| "INVALID_SUBTASK_DEPTH"
	| "INVALID_PRIORITY";

/**
 * Warning codes for validation warnings.
 */
export type ValidationWarningCode =
	| "MISSING_FILES"
	| "MISSING_ACCEPTANCE"
	| "EMPTY_DESCRIPTION";

/**
 * Detect circular dependencies using DFS.
 */
function detectCircularDependencies(tasks: SpecTask[]): string[][] {
	const taskMap = new Map(tasks.map((t) => [t.id, t]));
	const cycles: string[][] = [];
	const visited = new Set<string>();
	const recursionStack = new Set<string>();
	const pathStack: string[] = [];

	function dfs(taskId: string): boolean {
		if (recursionStack.has(taskId)) {
			// Found a cycle - extract it from pathStack
			const cycleStart = pathStack.indexOf(taskId);
			const cycle = [...pathStack.slice(cycleStart), taskId];
			cycles.push(cycle);
			return true;
		}

		if (visited.has(taskId)) {
			return false;
		}

		visited.add(taskId);
		recursionStack.add(taskId);
		pathStack.push(taskId);

		const task = taskMap.get(taskId);
		if (task) {
			for (const dep of task.dependsOn) {
				dfs(dep);
			}
		}

		pathStack.pop();
		recursionStack.delete(taskId);
		return false;
	}

	for (const task of tasks) {
		if (!visited.has(task.id)) {
			dfs(task.id);
		}
	}

	return cycles;
}

/**
 * Get all tasks that a task transitively depends on.
 */
function getTransitiveDependencies(taskId: string, tasks: SpecTask[]): Set<string> {
	const taskMap = new Map(tasks.map((t) => [t.id, t]));
	const deps = new Set<string>();
	const queue = [taskId];

	while (queue.length > 0) {
		const current = queue.shift()!;
		const task = taskMap.get(current);
		if (task) {
			for (const dep of task.dependsOn) {
				if (!deps.has(dep)) {
					deps.add(dep);
					queue.push(dep);
				}
			}
		}
	}

	return deps;
}

/**
 * Validate a spec and return detailed errors/warnings.
 */
export function validateSpec(spec: Spec): ValidationResult {
	const errors: ValidationError[] = [];
	const warnings: ValidationWarning[] = [];

	// Rule 1: At least one task
	if (spec.tasks.length === 0) {
		errors.push({
			code: "NO_TASKS",
			message: "Spec has no tasks. Use 'plan' tool to create tasks first.",
		});
		return {
			valid: false,
			errors,
			warnings,
			suggestion: "Run plan({ input: \"...\" }) to create a valid spec with tasks.",
		};
	}

	const taskIds = new Set<string>();
	const duplicateIds = new Set<string>();

	for (const task of spec.tasks) {
		// Rule 2: All task IDs are unique
		if (taskIds.has(task.id)) {
			duplicateIds.add(task.id);
		}
		taskIds.add(task.id);

		// Rule 7: Task IDs match valid patterns
		if (!TASK_ID_PATTERNS.any.test(task.id)) {
			errors.push({
				code: "INVALID_TASK_ID",
				message: `Invalid task ID: ${task.id} (expected TASK-XX, TASK-XX.Y, DISC-XX, or FIX-XX)`,
				taskId: task.id,
			});
		}

		// Rule 8: Subtasks don't exceed 2 levels
		if (task.id.match(/^TASK-\d+\.\d+\.\d+/)) {
			errors.push({
				code: "INVALID_SUBTASK_DEPTH",
				message: `Invalid subtask depth: ${task.id} (max 2 levels: TASK-XX.Y)`,
				taskId: task.id,
			});
		}

		// Validate priority
		if (!["P0", "P1", "P2", "P3"].includes(task.priority)) {
			errors.push({
				code: "INVALID_PRIORITY",
				message: `Invalid priority: ${task.priority} for ${task.id} (expected P0, P1, P2, or P3)`,
				taskId: task.id,
			});
		}

		// Warnings for optional fields
		if (task.files.length === 0) {
			warnings.push({
				code: "MISSING_FILES",
				message: `${task.id} has no files specified`,
				taskId: task.id,
			});
		}

		if (!task.acceptance) {
			warnings.push({
				code: "MISSING_ACCEPTANCE",
				message: `${task.id} has no acceptance criteria`,
				taskId: task.id,
			});
		}
	}

	// Report duplicate IDs
	for (const id of duplicateIds) {
		errors.push({
			code: "DUPLICATE_TASK_ID",
			message: `Duplicate task ID: ${id}`,
			taskId: id,
		});
	}

	// Rule 3: All dependencies reference existing tasks
	for (const task of spec.tasks) {
		for (const dep of task.dependsOn) {
			if (!taskIds.has(dep)) {
				errors.push({
					code: "MISSING_DEPENDENCY",
					message: `${task.id} depends on non-existent ${dep}`,
					taskId: task.id,
					details: { missingDep: dep },
				});
			}
		}
	}

	// Rule 4: No circular dependencies
	const cycles = detectCircularDependencies(spec.tasks);
	if (cycles.length > 0) {
		for (const cycle of cycles) {
			errors.push({
				code: "CIRCULAR_DEPENDENCY",
				message: `Circular dependency: ${cycle.join(" → ")}`,
				details: { cycle },
			});
		}
	}

	// Rule 5: At least one entry point
	// Only check top-level tasks (not subtasks which have implicit parent deps)
	const topLevelTasks = spec.tasks.filter((t) => !t.parentTaskId);
	const entryPoints = topLevelTasks.filter((t) => t.dependsOn.length === 0);
	if (entryPoints.length === 0 && topLevelTasks.length > 0) {
		errors.push({
			code: "NO_ENTRY_POINT",
			message: "No entry point task (all top-level tasks have dependencies). At least one task needs 'Depends on: none'.",
		});
	}

	// Build suggestion based on errors
	let suggestion: string | undefined;
	if (errors.length > 0) {
		const suggestions: string[] = [];

		if (errors.some((e) => e.code === "INVALID_TASK_ID")) {
			suggestions.push("Use TASK-XX format (e.g., TASK-01, TASK-02) for task IDs.");
		}
		if (errors.some((e) => e.code === "MISSING_DEPENDENCY")) {
			suggestions.push("Ensure all dependencies reference existing task IDs.");
		}
		if (errors.some((e) => e.code === "CIRCULAR_DEPENDENCY")) {
			suggestions.push("Remove circular dependencies - tasks cannot depend on each other in a cycle.");
		}
		if (errors.some((e) => e.code === "NO_ENTRY_POINT")) {
			suggestions.push("Add 'Depends on: none' to at least one task to create an entry point.");
		}

		suggestion = suggestions.length > 0
			? `To fix: ${suggestions.join(" ")}`
			: "Run 'plan' tool to create a valid spec, or fix the errors above.";
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		suggestion,
	};
}

/**
 * Get tasks that are ready to execute (all dependencies satisfied).
 */
export function getReadyTasks(
	spec: Spec,
	completedTasks: Set<string>,
	blockedTasks: Set<string> = new Set()
): SpecTask[] {
	return spec.tasks
		.filter((task) => {
			// Not already completed or blocked
			if (completedTasks.has(task.id)) return false;
			if (blockedTasks.has(task.id)) return false;
			if (task.status === "complete" || task.status === "blocked") return false;

			// All explicit dependencies completed
			if (!task.dependsOn.every((dep) => completedTasks.has(dep))) return false;

			// For subtasks: check implicit parent dependency
			// Subtasks are ready when parent is blocked waiting for them
			if (task.parentTaskId) {
				const parent = spec.tasks.find((t) => t.id === task.parentTaskId);
				if (!parent || parent.status !== "blocked") return false;
			}

			return true;
		})
		.sort((a, b) => {
			// Sort by priority (P0 first)
			const priorityOrder: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
			const pa = priorityOrder[a.priority];
			const pb = priorityOrder[b.priority];

			if (pa !== pb) return pa - pb;

			// Then by dependency count (fewer deps = more foundational)
			return a.dependsOn.length - b.dependsOn.length;
		});
}

/**
 * Check if all subtasks of a parent are complete.
 */
export function areSubtasksComplete(spec: Spec, parentTaskId: string, completedTasks: Set<string>): boolean {
	const subtasks = spec.tasks.filter((t) => t.parentTaskId === parentTaskId);
	return subtasks.length > 0 && subtasks.every((t) => completedTasks.has(t.id));
}

/**
 * Get topological order of tasks (respecting dependencies).
 */
export function getTopologicalOrder(spec: Spec): SpecTask[] {
	const result: SpecTask[] = [];
	const visited = new Set<string>();
	const taskMap = new Map(spec.tasks.map((t) => [t.id, t]));

	function visit(taskId: string): void {
		if (visited.has(taskId)) return;
		visited.add(taskId);

		const task = taskMap.get(taskId);
		if (task) {
			// Visit dependencies first
			for (const dep of task.dependsOn) {
				visit(dep);
			}
			result.push(task);
		}
	}

	for (const task of spec.tasks) {
		visit(task.id);
	}

	return result;
}

/**
 * Format validation result as a human-readable string.
 */
export function formatValidationResult(result: ValidationResult): string {
	const lines: string[] = [];

	if (result.valid) {
		lines.push("✓ Spec is valid");
	} else {
		lines.push("✗ Spec validation failed");
		lines.push("");
		lines.push("Errors:");
		for (const error of result.errors) {
			lines.push(`  - ${error.message}`);
		}
	}

	if (result.warnings.length > 0) {
		lines.push("");
		lines.push("Warnings:");
		for (const warning of result.warnings) {
			lines.push(`  - ${warning.message}`);
		}
	}

	if (result.suggestion) {
		lines.push("");
		lines.push(result.suggestion);
	}

	return lines.join("\n");
}
