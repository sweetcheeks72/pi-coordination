/**
 * Worker state utility helpers.
 *
 * Used by coordinator-tools/index.ts to populate enriched worker-state fields
 * (planIntent, thinkingStream, currentProblem, assumptions, deviationLog).
 */

/**
 * Parse [ASSUME: text | status | confidence] annotations from a message text.
 *
 * Returns only entries whose `text` is not already present in `existing`.
 */
export function parseAssumptions(
	text: string,
	existing: Array<{ text: string; status: "verified" | "unverified"; confidence: "high" | "med" | "low" }> = [],
): Array<{ text: string; status: "verified" | "unverified"; confidence: "high" | "med" | "low" }> {
	const pattern = /\[ASSUME:\s*([^|\]]+)\|\s*(verified|unverified)\s*\|\s*(high|med|low)\s*\]/gi;
	const results: Array<{ text: string; status: "verified" | "unverified"; confidence: "high" | "med" | "low" }> = [];
	let match;
	while ((match = pattern.exec(text)) !== null) {
		const assumptionText = match[1].trim();
		const status = match[2].toLowerCase() as "verified" | "unverified";
		const confidence = match[3].toLowerCase() as "high" | "med" | "low";
		// Avoid duplicates
		if (!existing.some((e) => e.text === assumptionText) && !results.some((r) => r.text === assumptionText)) {
			results.push({ text: assumptionText, status, confidence });
		}
	}
	return results;
}

/**
 * Concatenate all text blocks and return the last `maxChars` characters.
 * Returns an empty string if there is no text content.
 */
export function extractThinkingSnippet(
	contentBlocks: Array<{ type: string; text?: string }>,
	maxChars = 200,
): string {
	let text = "";
	for (const block of contentBlocks) {
		if (block.type === "text" && block.text) {
			text += block.text;
		}
	}
	if (!text) return "";
	return text.length <= maxChars ? text : text.slice(-maxChars);
}

/**
 * Inspect a tool_execution_end event for failure signals.
 *
 * Returns a one-line problem summary string when failure is detected, or `null`
 * when the tool succeeded.
 */
export function detectToolFailure(event: {
	toolName?: string | null;
	isError?: boolean;
	success?: boolean;
	error?: string;
	errorMessage?: string;
	exitCode?: number;
	output?: unknown;
	result?: unknown;
}): string | null {
	// Explicit error flags from the JSON event
	if (event.isError === true || event.success === false) {
		const msg = ((event.error ?? event.errorMessage) as string | undefined)?.trim() ?? "";
		if (msg) return _oneLine(msg);
		return `${event.toolName ?? "tool"} failed`;
	}

	// Non-zero exit code
	if (typeof event.exitCode === "number" && event.exitCode !== 0) {
		return `${event.toolName ?? "tool"} exited with code ${event.exitCode}`;
	}

	// Keyword scan on textual output
	const outputText =
		typeof event.output === "string" ? event.output :
		typeof event.result === "string" ? event.result :
		"";

	if (outputText && /\b(FAILED|ERROR|timeout|Timeout)\b/.test(outputText)) {
		const hitLine = outputText
			.split("\n")
			.find((l) => /\b(FAILED|ERROR|timeout|Timeout)\b/.test(l));
		if (hitLine) return _oneLine(hitLine);
	}

	return null;
}

/** Trim to first line and cap at 120 chars. */
function _oneLine(msg: string): string {
	const line = msg.split("\n")[0].trim();
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** Deviation log entry shape (mirrors Task["deviationLog"] element). */
export interface DeviationEntry {
	timestamp: number;
	what: string;
	why: string;
	decision: string;
	impact: string;
}

/**
 * Build a deviation log entry to attach to a Task when a retry succeeds
 * after a recorded problem.
 */
export function buildDeviationEntry(problem: string, toolName: string | null): DeviationEntry {
	return {
		timestamp: Date.now(),
		what: `Tool execution failed: ${toolName ?? "unknown tool"}`,
		why: problem,
		decision: "retried",
		impact: "minimal — retry succeeded",
	};
}
