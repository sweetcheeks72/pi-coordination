/**
 * Handoff Phase - Review spec and decide next action.
 *
 * Shows the spec summary and offers three choices:
 * 1. Execute now - Hand off to coordinate tool
 * 2. Refine further - Loop back to interview with existing spec
 * 3. Save and exit - Just save the spec file
 *
 * Timeout (60s) defaults to "Save and exit" to prevent accidental execution.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Spec, Priority } from "../coordinate/spec-parser.js";
import { serializeSpec } from "../coordinate/spec-parser.js";

/**
 * Handoff choice options.
 */
export type HandoffChoice = "execute" | "refine" | "exit";

/**
 * Handoff configuration.
 */
export interface HandoffConfig {
	/** Timeout in seconds (default: 60) */
	timeout?: number;
	/** Abort signal */
	signal?: AbortSignal;
	/** Whether to auto-save (default: true) */
	autoSave?: boolean;
}

/**
 * Result from handoff phase.
 */
export interface HandoffResult {
	/** User's choice */
	choice: HandoffChoice;
	/** Path where spec was saved */
	specPath: string;
	/** Whether choice was made via timeout */
	wasTimeout: boolean;
}

/**
 * Format a spec summary for display.
 */
export function formatSpecSummary(spec: Spec, specPath: string): string {
	const lines: string[] = [];

	const taskCount = spec.tasks.length;
	const fileCount = new Set(spec.tasks.flatMap((t) => t.files.map((f) => f.path))).size;
	const priorityCounts: Record<Priority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
	for (const task of spec.tasks) {
		priorityCounts[task.priority]++;
	}

	// Header
	lines.push("╭─────────────────────────────────────────────────────────────────╮");
	lines.push("│                      Spec Ready for Review                      │");
	lines.push("╰─────────────────────────────────────────────────────────────────╯");
	lines.push("");

	// Title
	lines.push(`  📋 ${spec.title || "(Untitled)"}`);
	lines.push("");

	// Stats
	lines.push(`  📁 Saved to: ${specPath}`);
	lines.push("");
	lines.push(`  📊 Summary:`);
	lines.push(`     • Tasks: ${taskCount}`);
	lines.push(`     • Files: ${fileCount}`);

	const priorityStr = Object.entries(priorityCounts)
		.filter(([_, count]) => count > 0)
		.map(([p, count]) => `${p}: ${count}`)
		.join(" | ");
	lines.push(`     • Priority: ${priorityStr}`);
	lines.push("");

	// Task list
	lines.push(`  📝 Tasks:`);
	for (const task of spec.tasks.slice(0, 8)) {
		const deps = task.dependsOn.length > 0 ? ` → ${task.dependsOn.join(", ")}` : "";
		const status = task.dependsOn.length === 0 ? "🟢" : "⏳";
		lines.push(`     ${status} ${task.id}: ${task.title}${deps}`);
	}
	if (spec.tasks.length > 8) {
		lines.push(`     ... and ${spec.tasks.length - 8} more`);
	}
	lines.push("");

	return lines.join("\n");
}

/**
 * Run handoff phase - show summary and get user choice.
 */
export async function runHandoff(
	spec: Spec,
	specPath: string,
	config: HandoffConfig = {},
): Promise<HandoffResult> {
	const { timeout = 60, signal, autoSave = true } = config;

	// Save spec first if autoSave enabled
	if (autoSave) {
		const specContent = serializeSpec(spec);
		await fs.mkdir(path.dirname(specPath), { recursive: true });
		await fs.writeFile(specPath, specContent, "utf-8");
	}

	// Non-TTY: save and exit (don't auto-execute)
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.log(formatSpecSummary(spec, specPath));
		console.log("(Non-TTY environment - saving and exiting)");
		return {
			choice: "exit",
			specPath,
			wasTimeout: false,
		};
	}

	// Check if already aborted
	if (signal?.aborted) {
		return {
			choice: "exit",
			specPath,
			wasTimeout: false,
		};
	}

	// Show summary
	console.log(formatSpecSummary(spec, specPath));

	// Run interactive choice
	const choice = await selectWithTimeout({
		question: "What would you like to do?",
		options: [
			{ label: "Execute now", value: "execute" as HandoffChoice, icon: "🚀" },
			{ label: "Refine further", value: "refine" as HandoffChoice, icon: "✏️" },
			{ label: "Save and exit", value: "exit" as HandoffChoice, icon: "💾" },
		],
		timeout,
		defaultOnTimeout: "exit" as HandoffChoice, // Don't auto-execute
		signal,
	});

	return {
		choice: choice.value,
		specPath,
		wasTimeout: choice.wasTimeout,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive Select with Timeout
// ─────────────────────────────────────────────────────────────────────────────

interface SelectOption<T> {
	label: string;
	value: T;
	icon?: string;
}

interface SelectConfig<T> {
	question: string;
	options: SelectOption<T>[];
	timeout: number;
	defaultOnTimeout: T;
	signal?: AbortSignal;
}

interface SelectResult<T> {
	value: T;
	wasTimeout: boolean;
}

async function selectWithTimeout<T>(config: SelectConfig<T>): Promise<SelectResult<T>> {
	const { question, options, timeout, defaultOnTimeout, signal } = config;

	return new Promise((resolve) => {
		let selectedIndex = options.findIndex((o) => o.value === defaultOnTimeout);
		if (selectedIndex < 0) selectedIndex = 0;

		let timeRemaining = timeout;
		let resolved = false;

		const stdin = process.stdin;
		const wasRaw = stdin.isRaw;

		if (stdin.isTTY) {
			stdin.setRawMode(true);
		}
		stdin.resume();

		const render = () => {
			const lines: string[] = [];

			lines.push("");
			lines.push(`  ${question} [${timeRemaining}s]`);
			lines.push("");

			for (let i = 0; i < options.length; i++) {
				const opt = options[i];
				const isSelected = i === selectedIndex;
				const prefix = isSelected ? "  › " : "    ";
				const icon = opt.icon ? `${opt.icon} ` : "";
				const highlight = isSelected ? "\x1b[1m" : "";
				const reset = isSelected ? "\x1b[0m" : "";
				lines.push(`${prefix}${highlight}${icon}${opt.label}${reset}`);
			}

			lines.push("");
			lines.push("  \x1b[2m[↑↓] select  [Enter] confirm  [Esc] save & exit\x1b[0m");
			lines.push("");

			// Move cursor up and redraw
			const totalHeight = lines.length;
			process.stdout.write(`\x1b[${totalHeight}A\x1b[0G`);
			process.stdout.write(lines.join("\n") + "\n");
		};

		// Initial render with spacing
		process.stdout.write("\n".repeat(10));
		render();

		// Timer
		const timerInterval = setInterval(() => {
			if (resolved) return;
			timeRemaining--;
			if (timeRemaining <= 0) {
				resolved = true;
				clearInterval(timerInterval);
				stdin.removeListener("data", onKeypress);
				if (stdin.isTTY && wasRaw !== undefined) {
					stdin.setRawMode(wasRaw);
				}
				stdin.pause();
				resolve({ value: defaultOnTimeout, wasTimeout: true });
			} else {
				render();
			}
		}, 1000);

		// Handle abort signal
		const onAbort = () => {
			if (resolved) return;
			resolved = true;
			clearInterval(timerInterval);
			stdin.removeListener("data", onKeypress);
			if (stdin.isTTY && wasRaw !== undefined) {
				stdin.setRawMode(wasRaw);
			}
			stdin.pause();
			resolve({ value: defaultOnTimeout, wasTimeout: false });
		};
		signal?.addEventListener("abort", onAbort);

		const onKeypress = (data: Buffer) => {
			if (resolved) return;

			const key = data.toString();

			// Esc - save and exit
			if (key === "\x1b" && data.length === 1) {
				resolved = true;
				clearInterval(timerInterval);
				signal?.removeEventListener("abort", onAbort);
				stdin.removeListener("data", onKeypress);
				if (stdin.isTTY && wasRaw !== undefined) {
					stdin.setRawMode(wasRaw);
				}
				stdin.pause();
				// Find exit option
				const exitOption = options.find((o) => o.value === ("exit" as unknown as T));
				resolve({ value: exitOption?.value || defaultOnTimeout, wasTimeout: false });
				return;
			}

			// Enter - confirm
			if (key === "\r" || key === "\n") {
				resolved = true;
				clearInterval(timerInterval);
				signal?.removeEventListener("abort", onAbort);
				stdin.removeListener("data", onKeypress);
				if (stdin.isTTY && wasRaw !== undefined) {
					stdin.setRawMode(wasRaw);
				}
				stdin.pause();
				resolve({ value: options[selectedIndex].value, wasTimeout: false });
				return;
			}

			// Arrow keys
			if (key === "\x1b[A" || key === "k") {
				// Up
				selectedIndex = Math.max(0, selectedIndex - 1);
				timeRemaining = timeout; // Reset timer on interaction
				render();
				return;
			}

			if (key === "\x1b[B" || key === "j") {
				// Down
				selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
				timeRemaining = timeout; // Reset timer on interaction
				render();
				return;
			}

			// Number keys for quick selection
			const num = Number.parseInt(key, 10);
			if (num >= 1 && num <= options.length) {
				selectedIndex = num - 1;
				timeRemaining = timeout;
				render();
				return;
			}
		};

		stdin.on("data", onKeypress);
	});
}

/**
 * Generate default spec filename from title.
 */
export function generateSpecFilename(title: string): string {
	const safeName = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);

	return `${safeName || "spec"}.md`;
}

/**
 * Resolve spec path - use provided path or generate from title.
 */
export function resolveSpecPath(cwd: string, output: string | undefined, title: string): string {
	if (output) {
		return path.isAbsolute(output) ? output : path.join(cwd, output);
	}

	const filename = generateSpecFilename(title);
	return path.join(cwd, "specs", filename);
}
