/**
 * Spec Parser - Parses TASK-XX format markdown into typed Spec structure.
 *
 * Spec Format:
 * ```markdown
 * # Title
 *
 * Description
 *
 * ## TASK-01: Task Title
 * Priority: P1
 * Files: src/file.ts (create), src/other.ts (modify)
 * Depends on: none
 * Acceptance: Tests pass
 *
 * Optional detailed description.
 * ```
 *
 * @module
 */

/**
 * Priority levels for tasks.
 */
export type Priority = "P0" | "P1" | "P2" | "P3";

/**
 * Status of a task during execution.
 */
export type TaskStatus = "pending" | "claimed" | "blocked" | "complete" | "failed" | "discovered";

/**
 * File annotation for what action to take.
 */
export type FileAction = "create" | "modify" | "delete";

/**
 * A file referenced by a task.
 */
export interface SpecFile {
	path: string;
	action?: FileAction;
}

/**
 * A task in the spec.
 */
export interface SpecTask {
	/** Task ID: TASK-XX, TASK-XX.Y, DISC-XX, FIX-XX */
	id: string;
	/** Task title from header */
	title: string;
	/** Priority level (default: P2) */
	priority: Priority;
	/** Files this task touches */
	files: SpecFile[];
	/** Task IDs this task depends on */
	dependsOn: string[];
	/** Acceptance criteria */
	acceptance: string;
	/** Optional detailed description */
	description?: string;
	/** Parent task ID for subtasks (TASK-XX.Y format) */
	parentTaskId?: string;
	/** Task status (set during execution) */
	status: TaskStatus;
	/** Task IDs blocking this task (set during execution) */
	blockedBy?: string[];
	/** Worker identity that claimed this task */
	claimedBy?: string;
	/** When the task was claimed */
	claimedAt?: number;
}

/**
 * A parsed specification.
 */
export interface Spec {
	/** Spec title */
	title: string;
	/** Spec description */
	description?: string;
	/** All tasks in the spec */
	tasks: SpecTask[];
	/** Optional context section content */
	context?: string;
	/** Source file path (if loaded from file) */
	sourcePath?: string;
}

/** Regex patterns for task IDs */
export const TASK_ID_PATTERNS = {
	/** TASK-XX format (original tasks) */
	taskMain: /^TASK-\d{2,}$/,
	/** TASK-XX.Y format (subtasks) */
	taskSub: /^TASK-\d{2,}\.\d+$/,
	/** DISC-XX format (discovered tasks) */
	disc: /^DISC-\d{2,}$/,
	/** FIX-XX format (fix tasks from reviewer) */
	fix: /^FIX-\d{2,}$/,
	/** Any valid task ID */
	any: /^(TASK-\d{2,}(\.\d+)?|DISC-\d{2,}|FIX-\d{2,})$/,
	/** Task header pattern: ## TASK-XX: Title */
	header: /^##\s+(TASK-\d{2,}(?:\.\d+)?|DISC-\d{2,}|FIX-\d{2,}):\s*(.+)$/,
};

/**
 * Parse a priority string to Priority type.
 */
function parsePriority(value: string | undefined): Priority {
	const normalized = value?.toUpperCase().trim();
	if (normalized === "P0" || normalized === "P1" || normalized === "P2" || normalized === "P3") {
		return normalized;
	}
	return "P2"; // Default
}

/**
 * Parse files from a "Files:" line.
 *
 * Supports formats:
 * - `src/file.ts (create), src/other.ts (modify)`
 * - `src/file.ts, src/other.ts`
 * - Multi-line with `- src/file.ts (create)`
 */
function parseFiles(text: string): SpecFile[] {
	const files: SpecFile[] = [];

	// Split by comma or newline
	const parts = text.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);

	for (let part of parts) {
		// Remove list prefix
		part = part.replace(/^-\s*/, "");

		// Extract action annotation: (create), (modify), (delete)
		const actionMatch = part.match(/\((\w+)\)\s*$/);
		let action: FileAction | undefined;
		if (actionMatch) {
			const actionStr = actionMatch[1].toLowerCase();
			if (actionStr === "create" || actionStr === "modify" || actionStr === "delete") {
				action = actionStr;
			}
			part = part.replace(/\(\w+\)\s*$/, "").trim();
		}

		if (part) {
			files.push({ path: part, action });
		}
	}

	return files;
}

/**
 * Parse dependencies from a "Depends on:" line.
 */
function parseDependsOn(text: string): string[] {
	const normalized = text.toLowerCase().trim();
	if (normalized === "none" || normalized === "-" || normalized === "n/a") {
		return [];
	}

	return text
		.split(/[,\n]/)
		.map((d) => d.trim().toUpperCase())
		.filter((d) => TASK_ID_PATTERNS.any.test(d));
}

/**
 * Extract the parent task ID from a subtask ID.
 */
function getParentTaskId(taskId: string): string | undefined {
	if (TASK_ID_PATTERNS.taskSub.test(taskId)) {
		return taskId.replace(/\.\d+$/, "");
	}
	return undefined;
}

/**
 * Parse a single task section.
 */
function parseTaskSection(section: string, header: { id: string; title: string }): SpecTask {
	const lines = section.split("\n");
	const task: SpecTask = {
		id: header.id,
		title: header.title,
		priority: "P2",
		files: [],
		dependsOn: [],
		acceptance: "",
		status: "pending",
		parentTaskId: getParentTaskId(header.id),
	};

	let currentField: "description" | "acceptance" | "files" | null = null;
	let descriptionLines: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Skip the header line
		if (TASK_ID_PATTERNS.header.test(trimmed)) {
			continue;
		}

		// Check for field prefixes
		const priorityMatch = trimmed.match(/^priority:\s*(.+)/i);
		if (priorityMatch) {
			task.priority = parsePriority(priorityMatch[1]);
			currentField = null;
			continue;
		}

		const filesMatch = trimmed.match(/^files?:\s*(.*)$/i);
		if (filesMatch) {
			if (filesMatch[1].trim()) {
				task.files = parseFiles(filesMatch[1]);
				currentField = null;
			} else {
				// Multi-line files
				currentField = "files";
			}
			continue;
		}

		const dependsMatch = trimmed.match(/^depends\s+on:\s*(.+)/i);
		if (dependsMatch) {
			task.dependsOn = parseDependsOn(dependsMatch[1]);
			currentField = null;
			continue;
		}

		const acceptanceMatch = trimmed.match(/^acceptance:\s*(.*)$/i);
		if (acceptanceMatch) {
			if (acceptanceMatch[1].trim()) {
				task.acceptance = acceptanceMatch[1].trim();
				currentField = null;
			} else {
				// Multi-line acceptance
				currentField = "acceptance";
				task.acceptance = "";
			}
			continue;
		}

		// Handle field continuations
		if (currentField === "files" && trimmed.startsWith("-")) {
			task.files.push(...parseFiles(trimmed));
			continue;
		}

		if (currentField === "acceptance" && trimmed) {
			task.acceptance += (task.acceptance ? "\n" : "") + trimmed;
			continue;
		}

		// Everything else is description
		if (trimmed) {
			descriptionLines.push(trimmed);
		}
	}

	if (descriptionLines.length > 0) {
		task.description = descriptionLines.join("\n");
	}

	return task;
}

/**
 * Parse a spec from markdown text.
 */
export function parseSpec(markdown: string, sourcePath?: string): Spec {
	const lines = markdown.split("\n");
	const spec: Spec = {
		title: "",
		tasks: [],
		sourcePath,
	};

	// Extract title from first # heading
	for (const line of lines) {
		const titleMatch = line.match(/^#\s+(.+)$/);
		if (titleMatch) {
			spec.title = titleMatch[1].trim();
			break;
		}
	}

	// Split into sections by ## headers
	const sections: string[] = [];
	let currentSection: string[] = [];
	let inTasks = false;
	let descriptionLines: string[] = [];
	let contextLines: string[] = [];
	let inContext = false;

	for (const line of lines) {
		// Check for ## headers
		if (line.match(/^##\s+/)) {
			// Check if this is a task header
			const taskMatch = line.match(TASK_ID_PATTERNS.header);

			if (taskMatch) {
				// Save previous section
				if (currentSection.length > 0) {
					sections.push(currentSection.join("\n"));
				}
				currentSection = [line];
				inTasks = true;
				inContext = false;
			} else if (line.match(/^##\s+context/i)) {
				// Context section
				if (currentSection.length > 0) {
					sections.push(currentSection.join("\n"));
					currentSection = [];
				}
				inContext = true;
				inTasks = false;
			} else {
				// Non-task section header
				if (currentSection.length > 0) {
					sections.push(currentSection.join("\n"));
				}
				currentSection = [line];
				inContext = false;
			}
		} else if (inContext) {
			contextLines.push(line);
		} else if (inTasks) {
			currentSection.push(line);
		} else if (!spec.title || line.match(/^#\s+/)) {
			// Before tasks, part of header
			continue;
		} else if (line.trim() && !line.match(/^---/)) {
			// Description between title and first task
			descriptionLines.push(line);
		}
	}

	// Save last section
	if (currentSection.length > 0) {
		sections.push(currentSection.join("\n"));
	}

	// Parse description
	if (descriptionLines.length > 0) {
		spec.description = descriptionLines.join("\n").trim();
	}

	// Parse context
	if (contextLines.length > 0) {
		spec.context = contextLines.join("\n").trim();
	}

	// Parse task sections
	for (const section of sections) {
		// Match only the first line of the section (header line)
		const firstLine = section.split("\n")[0];
		const headerMatch = firstLine.match(TASK_ID_PATTERNS.header);
		if (headerMatch) {
			const task = parseTaskSection(section, {
				id: headerMatch[1],
				title: headerMatch[2].trim(),
			});
			spec.tasks.push(task);
		}
	}

	return spec;
}

/**
 * Serialize a spec back to markdown.
 */
export function serializeSpec(spec: Spec): string {
	const lines: string[] = [];

	// Title
	lines.push(`# ${spec.title}`);
	lines.push("");

	// Description
	if (spec.description) {
		lines.push(spec.description);
		lines.push("");
	}

	lines.push("---");
	lines.push("");

	// Tasks
	for (const task of spec.tasks) {
		lines.push(`## ${task.id}: ${task.title}`);
		lines.push(`Priority: ${task.priority}`);

		if (task.files.length > 0) {
			const fileStr = task.files
				.map((f) => (f.action ? `${f.path} (${f.action})` : f.path))
				.join(", ");
			lines.push(`Files: ${fileStr}`);
		}

		const deps = task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none";
		lines.push(`Depends on: ${deps}`);
		lines.push(`Acceptance: ${task.acceptance}`);

		if (task.description) {
			lines.push("");
			lines.push(task.description);
		}

		lines.push("");
	}

	// Context
	if (spec.context) {
		lines.push("---");
		lines.push("");
		lines.push("## Context");
		lines.push("");
		lines.push(spec.context);
	}

	return lines.join("\n");
}
