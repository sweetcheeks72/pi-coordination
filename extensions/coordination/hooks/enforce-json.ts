/**
 * Output validation hook: Enforce JSON output.
 *
 * This extension validates that the agent's output is valid JSON.
 * If invalid, it sends a retry message asking for valid JSON.
 *
 * Configuration via environment variable:
 *   PI_ENFORCE_JSON_MAX_RETRIES=3  (default: 2)
 *
 * Usage in agent frontmatter:
 * ```yaml
 * ---
 * name: my-agent
 * extensions: ../hooks/enforce-json.ts
 * ---
 * ```
 *
 * @module
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Maximum retry attempts. Override via PI_ENFORCE_JSON_MAX_RETRIES env var. */
const MAX_RETRIES = (() => {
	const val = parseInt(process.env.PI_ENFORCE_JSON_MAX_RETRIES || "2", 10);
	return Number.isNaN(val) ? 2 : val;
})();

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
 * Try to extract JSON from text that might have markdown code blocks.
 */
function extractJSON(text: string): string {
	// Try to extract from markdown code block
	const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (jsonBlockMatch) {
		return jsonBlockMatch[1].trim();
	}

	// Try the whole text
	return text.trim();
}

/**
 * Validate that text is valid JSON.
 */
function isValidJSON(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

export default function enforceJson(pi: ExtensionAPI): void {
	let retryCount = 0;

	pi.on("agent_end", async (event, ctx) => {
		const text = extractTextFromMessages(event.messages);
		const jsonText = extractJSON(text);

		// Check if output is valid JSON
		if (isValidJSON(jsonText)) {
			// Reset retry count on success
			retryCount = 0;
			return;
		}

		// Invalid JSON - retry if under limit
		if (retryCount < MAX_RETRIES) {
			retryCount++;
			console.log(`[enforce-json] Invalid JSON output, retry ${retryCount}/${MAX_RETRIES}`);

			pi.sendMessage(
				{
					customType: "enforce-json-retry",
					content: `Your output is not valid JSON. Please output ONLY valid JSON, no explanation or markdown. Attempt ${retryCount}/${MAX_RETRIES}.`,
					display: false,
				},
				{ triggerTurn: true }
			);
		} else {
			// Max retries exceeded
			console.warn(`[enforce-json] Max retries (${MAX_RETRIES}) exceeded, giving up`);
			retryCount = 0;
		}
	});

	// Reset retry count at the start of each agent run
	pi.on("agent_start", () => {
		retryCount = 0;
	});
}
