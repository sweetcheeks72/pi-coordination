/**
 * PRD augmentation - appends clarifying question answers to original content
 */

import type { Answer } from "./inline-questions-tui.js";

export interface AugmentOptions {
	markTimeouts?: boolean; // Show "(default - no response)" for timeout answers
}

/**
 * Augment PRD content with clarifying question answers
 * @param original - Original PRD content
 * @param answers - Array of answers from the questions TUI
 * @param options - Augmentation options
 * @returns Augmented PRD content
 */
export function augmentPRD(
	original: string,
	answers: Answer[],
	options: AugmentOptions = {},
): string {
	const { markTimeouts = true } = options;

	if (answers.length === 0) {
		return original;
	}

	const lines: string[] = [];

	for (const answer of answers) {
		const valueStr = formatAnswerValue(answer);
		const suffix = markTimeouts && answer.wasTimeout ? " *(default - no response)*" : "";
		const customMarker = answer.wasCustom ? " *(custom)*" : "";
		lines.push(`- **${answer.question}**: ${valueStr}${suffix}${customMarker}`);
	}

	return `${original.trimEnd()}

---

## Clarifications

${lines.join("\n")}
`;
}

function formatAnswerValue(answer: Answer): string {
	if (answer.type === "confirm") {
		return answer.value ? "Yes" : "No";
	}
	if (answer.type === "select" && answer.selectedOption && !answer.wasCustom) {
		return answer.selectedOption.label;
	}
	return String(answer.value) || "(no answer)";
}

/**
 * Extract clarifications section from augmented PRD
 * Useful for logging/debugging
 */
export function extractClarifications(augmentedPRD: string): string | null {
	const match = augmentedPRD.match(/## Clarifications\n\n([\s\S]*?)(?:\n---|\n##|$)/);
	return match ? match[1].trim() : null;
}
