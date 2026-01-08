/**
 * Inline TUI for sequential clarifying questions
 * Each question has a 60s timer, options + text input field
 */

import type { ClarifyingQuestion, QuestionOption } from "./question-generator.js";

// ANSI codes for styling
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export interface Answer {
	questionId: string;
	question: string;
	type: "select" | "text" | "confirm";
	value: string | boolean;
	selectedOption?: QuestionOption;
	wasTimeout: boolean;
	wasCustom: boolean; // True if user typed custom text instead of selecting option
}

export interface InlineQuestionsTUIOptions {
	questions: ClarifyingQuestion[];
	timeout?: number; // seconds per question, default 60
	write?: (text: string) => void;
	signal?: AbortSignal;
}

export interface InlineQuestionsTUIResult {
	answers: Answer[];
	skippedAll: boolean;
	timeoutCount: number;
}

const DEFAULT_TIMEOUT = 60;
const BOX_WIDTH = 70;

/**
 * Run the inline questions TUI sequentially
 */
export async function runInlineQuestionsTUI(
	options: InlineQuestionsTUIOptions,
): Promise<InlineQuestionsTUIResult> {
	const { questions, timeout = DEFAULT_TIMEOUT, write = process.stdout.write.bind(process.stdout), signal } = options;

	if (questions.length === 0) {
		return { answers: [], skippedAll: false, timeoutCount: 0 };
	}

	// Check if already aborted
	if (signal?.aborted) {
		return {
			answers: questions.map(q => createDefaultAnswer(q, true)),
			skippedAll: true,
			timeoutCount: questions.length,
		};
	}

	const answers: Answer[] = [];
	let skippedAll = false;
	let timeoutCount = 0;

	// Store original terminal state
	const stdin = process.stdin;
	const wasRaw = stdin.isRaw;

	// Enable raw mode for key capture
	if (stdin.isTTY) {
		stdin.setRawMode(true);
	}
	stdin.resume();

	// Handle abort signal
	const onAbort = () => {
		skippedAll = true;
	};
	signal?.addEventListener("abort", onAbort);

	try {
		for (let qIndex = 0; qIndex < questions.length; qIndex++) {
			if (skippedAll || signal?.aborted) {
				// Use defaults for remaining questions
				const q = questions[qIndex];
				answers.push(createDefaultAnswer(q, true));
				timeoutCount++;
				continue;
			}

			const q = questions[qIndex];
			const answer = await runSingleQuestion(q, qIndex, questions.length, answers, timeout, write, stdin, () => {
				skippedAll = true;
			});

			if (answer.wasTimeout) {
				timeoutCount++;
			}
			answers.push(answer);
		}
	} finally {
		// Always restore terminal state
		signal?.removeEventListener("abort", onAbort);
		if (stdin.isTTY && wasRaw !== undefined) {
			stdin.setRawMode(wasRaw);
		}
		stdin.pause();
	}

	return { answers, skippedAll, timeoutCount };
}

async function runSingleQuestion(
	question: ClarifyingQuestion,
	currentIndex: number,
	totalQuestions: number,
	previousAnswers: Answer[],
	timeout: number,
	write: (text: string) => void,
	stdin: NodeJS.ReadStream,
	onSkipAll: () => void,
): Promise<Answer> {
	return new Promise((resolve) => {
		let selectedIndex = typeof question.default === "number" ? question.default : 0;
		let customText = "";
		let timeRemaining = timeout;
		let resolved = false;

		// For select questions, count options (custom text field is separate)
		const optionCount = question.type === "select" ? (question.options?.length ?? 0) : 0;
		
		// If select has no options, start in custom field
		let isInCustomField = question.type === "select" && optionCount === 0;

		const render = () => {
			const width = Math.min(process.stdout.columns || 80, BOX_WIDTH);
			const lines: string[] = [];

			// Box top with progress and timer
			const progress = `(${currentIndex + 1}/${totalQuestions})`;
			const title = ` Clarifying Questions ${progress} `;
			const timerStr = `[:${timeRemaining.toString().padStart(2, "0")}]`;
			const padLen = width - 4 - title.length - timerStr.length;
			lines.push(`╭─${title}${"─".repeat(Math.max(0, padLen))}${timerStr}─╮`);

			// Empty line
			lines.push(`│${" ".repeat(width - 2)}│`);

			// Question
			const qText = `  ${question.question}`;
			lines.push(`│${truncate(qText, width - 2).padEnd(width - 2)}│`);
			
			// Show context if available (dimmed)
			if (question.context) {
				// Truncate context first (without ANSI codes), then add styling
				// truncate() now also sanitizes newlines
				const truncatedContext = truncate(question.context, width - 8);
				// Calculate padding needed (based on visual length, not including ANSI codes)
				const visualLength = 2 + truncatedContext.length; // "  " prefix + context
				const padding = Math.max(0, width - 2 - visualLength);
				lines.push(`│  ${DIM}${truncatedContext}${RESET}${" ".repeat(padding)}│`);
			}
			
			lines.push(`│${" ".repeat(width - 2)}│`);

			// Render based on question type
			if (question.type === "select" && question.options) {
				// Options
				for (let i = 0; i < question.options.length; i++) {
					const opt = question.options[i];
					const isSelected = !isInCustomField && i === selectedIndex;
					const prefix = isSelected ? "  › " : "    ";
					const optText = `${prefix}${opt.label}`;
					lines.push(`│${truncate(optText, width - 2).padEnd(width - 2)}│`);
				}

				// Custom text field
				lines.push(`│${" ".repeat(width - 2)}│`);
				const customPrefix = isInCustomField ? "  › " : "    ";
				const customLabel = `${customPrefix}Other: `;
				const inputWidth = width - 4 - customLabel.length - 2;
				const displayText = customText.slice(-inputWidth); // Show end of text if too long
				const cursor = isInCustomField ? "▌" : "";
				const fieldContent = `${customLabel}${displayText}${cursor}`;
				lines.push(`│${fieldContent.padEnd(width - 2)}│`);

			} else if (question.type === "confirm") {
				const yesSelected = selectedIndex === 0;
				const yesPrefix = yesSelected ? "› " : "  ";
				const noPrefix = !yesSelected ? "› " : "  ";
				lines.push(`│    ${yesPrefix}Yes${" ".repeat(10)}${noPrefix}No${" ".repeat(width - 26)}│`);

			} else {
				// Text type - just show input field
				const inputWidth = width - 8;
				const displayText = customText.slice(-inputWidth);
				const cursor = "▌";
				lines.push(`│    ${displayText}${cursor}${" ".repeat(Math.max(0, inputWidth - displayText.length - 1))}│`);
			}

			// Separator
			lines.push(`│${" ".repeat(width - 2)}│`);
			lines.push(`│${"─".repeat(width - 2)}│`);

			// Previous answers (show last 3)
			const recentAnswers = previousAnswers.slice(-3);
			if (recentAnswers.length > 0) {
				for (const ans of recentAnswers) {
					const checkmark = ans.wasTimeout ? "○" : "✓";
					const valueStr = formatAnswerValue(ans);
					const ansLine = `  ${checkmark} ${truncate(ans.question, 25)}: ${truncate(valueStr, width - 35)}`;
					lines.push(`│${ansLine.padEnd(width - 2)}│`);
				}
			}

			// Box bottom with controls
			lines.push(`│${" ".repeat(width - 2)}│`);
			const controls = " [↑↓] select  [Enter] confirm  [Esc] skip all ";
			const bottomPad = width - 2 - controls.length;
			lines.push(`╰${"─".repeat(Math.max(0, bottomPad))}${controls}╯`);

			// Calculate total height for cursor positioning
			const totalHeight = lines.length;
			write(`\x1b[${totalHeight}A\x1b[0G`);
			write(lines.join("\n") + "\n");
		};

		// Calculate initial height based on question type to ensure we don't overwrite content above
		// Base: box top (1) + 2 empty lines + question (1) + context (0-1) + 2 separator lines + empty + bottom = 8-9
		// Plus: options/controls + previous answers
		const baseHeight = 8 + (question.context ? 1 : 0);
		const optionsHeight = question.type === "select" 
			? (question.options?.length ?? 0) + 3 // options + empty + custom field
			: 1;
		const answersHeight = Math.min(previousAnswers.length, 3);
		const initialHeight = Math.max(15, baseHeight + optionsHeight + answersHeight + 2); // +2 for safety margin
		
		// Initial render - add blank lines first
		write("\n".repeat(initialHeight));
		render();

		// Timer interval
		const timerInterval = setInterval(() => {
			if (resolved) return;
			timeRemaining--;
			if (timeRemaining <= 0) {
				resolved = true;
				clearInterval(timerInterval);
				stdin.removeListener("data", onKeypress);
				resolve(createDefaultAnswer(question, true));
			} else {
				render();
			}
		}, 1000);

		const onKeypress = (data: Buffer) => {
			if (resolved) return;

			const key = data.toString();

			// Esc - skip all remaining
			if (key === "\x1b" && data.length === 1) {
				resolved = true;
				clearInterval(timerInterval);
				stdin.removeListener("data", onKeypress);
				onSkipAll();
				resolve(createDefaultAnswer(question, true));
				return;
			}

			// Enter - confirm
			if (key === "\r" || key === "\n") {
				resolved = true;
				clearInterval(timerInterval);
				stdin.removeListener("data", onKeypress);

				if (question.type === "select") {
					if (isInCustomField && customText.trim()) {
						resolve({
							questionId: question.id,
							question: question.question,
							type: "select",
							value: customText.trim(),
							wasTimeout: false,
							wasCustom: true,
						});
					} else {
						const selectedOption = question.options?.[selectedIndex];
						resolve({
							questionId: question.id,
							question: question.question,
							type: "select",
							value: selectedOption?.value ?? "",
							selectedOption,
							wasTimeout: false,
							wasCustom: false,
						});
					}
				} else if (question.type === "confirm") {
					resolve({
						questionId: question.id,
						question: question.question,
						type: "confirm",
						value: selectedIndex === 0,
						wasTimeout: false,
						wasCustom: false,
					});
				} else {
					resolve({
						questionId: question.id,
						question: question.question,
						type: "text",
						value: customText.trim() || (question.default as string) || "",
						wasTimeout: false,
						wasCustom: true,
					});
				}
				return;
			}

			// Handle text input when in custom field or text type
			if (isInCustomField || question.type === "text") {
				// Backspace
				if (key === "\x7f" || key === "\b") {
					customText = customText.slice(0, -1);
					timeRemaining = timeout; // Reset timer
					render();
					return;
				}

				// Printable characters
				if (key.length === 1 && key >= " " && key <= "~") {
					customText += key;
					timeRemaining = timeout; // Reset timer
					render();
					return;
				}
			}

			// Arrow keys navigation
			if (key === "\x1b[A" || key === "k") {
				// Up
				if (question.type === "select") {
					if (isInCustomField) {
						isInCustomField = false;
						// Ensure we don't go negative if there are no options
						selectedIndex = Math.max(0, optionCount - 1);
					} else if (selectedIndex > 0) {
						selectedIndex--;
					}
				} else if (question.type === "confirm") {
					selectedIndex = 0;
				}
				timeRemaining = timeout; // Reset timer
				render();
				return;
			}

			if (key === "\x1b[B" || key === "j") {
				// Down
				if (question.type === "select") {
					if (!isInCustomField) {
						if (selectedIndex < optionCount - 1) {
							selectedIndex++;
						} else {
							isInCustomField = true;
						}
					}
				} else if (question.type === "confirm") {
					selectedIndex = 1;
				}
				timeRemaining = timeout; // Reset timer
				render();
				return;
			}

			// Tab to toggle custom field
			if (key === "\t" && question.type === "select") {
				isInCustomField = !isInCustomField;
				timeRemaining = timeout;
				render();
				return;
			}
		};

		stdin.on("data", onKeypress);
	});
}

function createDefaultAnswer(question: ClarifyingQuestion, wasTimeout: boolean): Answer {
	if (question.type === "select") {
		const defaultIdx = typeof question.default === "number" ? question.default : 0;
		const selectedOption = question.options?.[defaultIdx];
		return {
			questionId: question.id,
			question: question.question,
			type: "select",
			value: selectedOption?.value ?? "",
			selectedOption,
			wasTimeout,
			wasCustom: false,
		};
	} else if (question.type === "confirm") {
		return {
			questionId: question.id,
			question: question.question,
			type: "confirm",
			value: question.default !== false,
			wasTimeout,
			wasCustom: false,
		};
	} else {
		return {
			questionId: question.id,
			question: question.question,
			type: "text",
			value: (question.default as string) || "",
			wasTimeout,
			wasCustom: false,
		};
	}
}

function formatAnswerValue(answer: Answer): string {
	if (answer.type === "confirm") {
		return answer.value ? "Yes" : "No";
	}
	if (answer.type === "select" && answer.selectedOption) {
		return answer.selectedOption.label;
	}
	return String(answer.value);
}

/**
 * Sanitize text for single-line display (replace newlines with spaces)
 */
function sanitize(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLen: number): string {
	const clean = sanitize(text);
	if (clean.length <= maxLen) return clean;
	if (maxLen <= 3) return clean.slice(0, maxLen); // No room for "..."
	return clean.slice(0, maxLen - 3) + "...";
}
