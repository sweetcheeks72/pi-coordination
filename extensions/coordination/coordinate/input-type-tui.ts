/**
 * TUI component for confirming/overriding detected input type
 * Shows 3 options with pre-selection based on detection, 60s timer
 */

import type { InputType, DetectionResult } from "./detection.js";
import { getInputTypeDescription } from "./detection.js";

export interface InputTypeResult {
	type: InputType;
	wasTimeout: boolean;
	wasOverride: boolean;
}

export interface InputTypeTUIOptions {
	detected: DetectionResult;
	timeout?: number; // seconds, default 60
	write?: (text: string) => void;
	signal?: AbortSignal;
}

const INPUT_TYPES: InputType[] = ["spec", "plan", "request"];
const DEFAULT_TIMEOUT = 60;

/**
 * Run the input type selection TUI
 * @returns Selected type or null if aborted (Esc or signal)
 */
export async function runInputTypeTUI(options: InputTypeTUIOptions): Promise<InputTypeResult | null> {
	const { detected, timeout = DEFAULT_TIMEOUT, write = process.stdout.write.bind(process.stdout), signal } = options;
	
	// Check if already aborted
	if (signal?.aborted) {
		return null;
	}
	
	let selectedIndex = INPUT_TYPES.indexOf(detected.type);
	let timeRemaining = timeout;

	// Store original terminal state
	const stdin = process.stdin;
	const wasRaw = stdin.isRaw;
	
	// Enable raw mode for key capture
	if (stdin.isTTY) {
		stdin.setRawMode(true);
	}
	stdin.resume();

	const render = () => {
		// Clear and redraw
		const width = Math.min(process.stdout.columns || 80, 70);
		const lines: string[] = [];
		
		// Box top
		const title = " Input Type ";
		const timerStr = `[:${timeRemaining.toString().padStart(2, "0")}]`;
		const padLen = width - 4 - title.length - timerStr.length;
		lines.push(`╭─${title}${"─".repeat(Math.max(0, padLen))}${timerStr}─╮`);
		
		// Empty line
		lines.push(`│${" ".repeat(width - 2)}│`);
		
		// Question
		const question = "  What did you provide?";
		lines.push(`│${question.padEnd(width - 2)}│`);
		lines.push(`│${" ".repeat(width - 2)}│`);
		
		// Options
		for (let i = 0; i < INPUT_TYPES.length; i++) {
			const type = INPUT_TYPES[i];
			const { label, description } = getInputTypeDescription(type);
			const isSelected = i === selectedIndex;
			const prefix = isSelected ? "  › " : "    ";
			const optionText = `${prefix}${label} - ${description}`;
			const truncated = optionText.slice(0, width - 4);
			lines.push(`│${truncated.padEnd(width - 2)}│`);
		}
		
		// Empty line
		lines.push(`│${" ".repeat(width - 2)}│`);
		
		// Box bottom with controls
		const controls = " [↑↓] select  [Enter] confirm  [Esc] abort ";
		const bottomPad = width - 2 - controls.length;
		lines.push(`╰${"─".repeat(Math.max(0, bottomPad))}${controls}╯`);
		
		// Move cursor up and redraw
		const totalLines = lines.length;
		write(`\x1b[${totalLines}A\x1b[0G`);
		write(lines.join("\n") + "\n");
	};

	// Initial render - add blank lines first
	const initialHeight = 10;
	write("\n".repeat(initialHeight));
	render();

	return new Promise((resolve) => {
		let timerInterval: NodeJS.Timeout | null = null;
		let finished = false;
		
		const cleanup = () => {
			if (timerInterval) {
				clearInterval(timerInterval);
				timerInterval = null;
			}
			stdin.removeListener("data", onKeypress);
			signal?.removeEventListener("abort", onAbort);
			if (stdin.isTTY && wasRaw !== undefined) {
				stdin.setRawMode(wasRaw);
			}
			stdin.pause();
		};

		const finish = (result: InputTypeResult | null) => {
			if (finished) return;
			finished = true;
			cleanup();
			resolve(result);
		};

		const onAbort = () => {
			finish(null);
		};

		const onKeypress = (data: Buffer) => {
			if (finished) return;
			
			const key = data.toString();
			
			// Esc - abort (standalone escape is 1 byte)
			if (key === "\x1b" && data.length === 1) {
				finish(null);
				return;
			}
			
			// Enter - confirm
			if (key === "\r" || key === "\n") {
				finish({
					type: INPUT_TYPES[selectedIndex],
					wasTimeout: false,
					wasOverride: selectedIndex !== INPUT_TYPES.indexOf(detected.type),
				});
				return;
			}
			
			// Arrow keys and j/k
			let moved = false;
			if (key === "\x1b[A" || key === "k") {
				// Up
				selectedIndex = Math.max(0, selectedIndex - 1);
				moved = true;
			} else if (key === "\x1b[B" || key === "j") {
				// Down
				selectedIndex = Math.min(INPUT_TYPES.length - 1, selectedIndex + 1);
				moved = true;
			}
			
			if (moved) {
				// Reset timer on interaction
				timeRemaining = timeout;
				render();
			}
		};

		// Set up abort signal handler
		signal?.addEventListener("abort", onAbort);

		// Set up keypress handler
		stdin.on("data", onKeypress);

		// Timer interval
		timerInterval = setInterval(() => {
			if (finished) return;
			timeRemaining--;
			if (timeRemaining <= 0) {
				// Timeout - use current selection
				finish({
					type: INPUT_TYPES[selectedIndex],
					wasTimeout: true,
					wasOverride: selectedIndex !== INPUT_TYPES.indexOf(detected.type),
				});
			} else {
				render();
			}
		}, 1000);
	});
}
