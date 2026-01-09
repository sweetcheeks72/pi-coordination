/**
 * Output validation hook: Enforce scout output format.
 *
 * This extension validates that scout output contains required sections:
 * - <meta> or ## Meta Prompt section
 * - <file_map> or ## File Map section
 * - <file_contents> or ## File Contents section
 *
 * Configuration via environment variable:
 *   PI_ENFORCE_SCOUT_MAX_RETRIES=3  (default: 2)
 *
 * Usage in agent frontmatter:
 * ```yaml
 * ---
 * name: coordination/scout
 * extensions: ../hooks/enforce-scout-format.ts
 * ---
 * ```
 *
 * @module
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Maximum retry attempts. Override via PI_ENFORCE_SCOUT_MAX_RETRIES env var. */
const MAX_RETRIES = (() => {
	const val = parseInt(process.env.PI_ENFORCE_SCOUT_MAX_RETRIES || "2", 10);
	return Number.isNaN(val) ? 2 : val;
})();

interface ScoutFormatValidation {
	valid: boolean;
	hasMeta: boolean;
	hasFileMap: boolean;
	hasFileContents: boolean;
	missingSections: string[];
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
 * Validate scout output format.
 */
function validateScoutFormat(text: string): ScoutFormatValidation {
	const normalizedText = text.toLowerCase();

	// Check for required sections (both XML tag and markdown header formats)
	const hasMeta = normalizedText.includes("<meta>") ||
		normalizedText.includes("</meta>") ||
		normalizedText.includes("# meta prompt") ||
		normalizedText.includes("## meta prompt") ||
		normalizedText.includes("# planning guidance") ||
		normalizedText.includes("## planning guidance");

	const hasFileMap = normalizedText.includes("<file_map>") ||
		normalizedText.includes("</file_map>") ||
		normalizedText.includes("# file map") ||
		normalizedText.includes("## file map") ||
		normalizedText.includes("# file tree") ||
		normalizedText.includes("## file tree");

	const hasFileContents = normalizedText.includes("<file_contents>") ||
		normalizedText.includes("</file_contents>") ||
		normalizedText.includes("# file contents") ||
		normalizedText.includes("## file contents") ||
		normalizedText.includes("# relevant files") ||
		normalizedText.includes("## relevant files");

	const missingSections: string[] = [];
	if (!hasMeta) missingSections.push("meta/planning guidance");
	if (!hasFileMap) missingSections.push("file_map");
	if (!hasFileContents) missingSections.push("file_contents");

	return {
		valid: hasMeta && hasFileMap && hasFileContents,
		hasMeta,
		hasFileMap,
		hasFileContents,
		missingSections,
	};
}

export default function enforceScoutFormat(pi: ExtensionAPI): void {
	let retryCount = 0;

	pi.on("agent_end", async (event, ctx) => {
		const text = extractTextFromMessages(event.messages);
		const validation = validateScoutFormat(text);

		if (validation.valid) {
			// Reset retry count on success
			retryCount = 0;
			return;
		}

		// Invalid format - retry if under limit
		if (retryCount < MAX_RETRIES) {
			retryCount++;
			const missing = validation.missingSections.join(", ");
			console.log(`[enforce-scout-format] Missing sections: ${missing}, retry ${retryCount}/${MAX_RETRIES}`);

			pi.sendMessage(
				{
					customType: "enforce-scout-format-retry",
					content: `Your scout output is missing required sections: ${missing}

Please include ALL of these sections in your output:
1. **Meta Prompt / Planning Guidance** - Synthesized guidance for the planner
2. **File Map** - Tree structure of relevant files
3. **File Contents** - Actual content of key files

Use either XML tags (<meta>, <file_map>, <file_contents>) or markdown headers (## Meta Prompt, ## File Map, ## File Contents).

Attempt ${retryCount}/${MAX_RETRIES}.`,
					display: false,
				},
				{ triggerTurn: true }
			);
		} else {
			// Max retries exceeded
			console.warn(`[enforce-scout-format] Max retries (${MAX_RETRIES}) exceeded, giving up`);
			retryCount = 0;
		}
	});

	// Reset retry count at the start of each agent run
	pi.on("agent_start", () => {
		retryCount = 0;
	});
}
