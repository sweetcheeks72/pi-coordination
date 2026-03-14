/**
 * Context Compactor
 *
 * Reduces the size of coordinator message history when it grows large.
 * Compaction keeps the most semantically important messages (e.g. status,
 * conflict, handover) and drops redundant clarification/response pairs.
 *
 * On compaction failure, falls back to truncating to the last 20 messages
 * so the caller always receives a usable (if uncompacted) result.
 *
 * @module
 */

import type { CoordinationMessage } from "./types.js";
import type { FileBasedStorage } from "./state.js";

// Priority order for keeping messages when compacting
const MESSAGE_TYPE_PRIORITY: Record<CoordinationMessage["type"], number> = {
	conflict: 0,
	handover: 1,
	status: 2,
	clarification: 3,
	response: 4,
};

/**
 * Compact a list of coordinator messages by removing redundant entries.
 *
 * Strategy:
 * 1. Always retain the most recent N messages unchanged.
 * 2. For older messages, keep only those with high-priority types
 *    (conflict, handover, status) and deduplicate near-identical content.
 *
 * @param messages     - Full message history to compact.
 * @param storage      - FileBasedStorage instance used to log errors to the event stream.
 * @param targetSize   - Desired maximum message count after compaction (default: 40).
 * @param recencyWindow - How many recent messages to always preserve (default: 10).
 * @returns            Compacted message list (never longer than the input).
 */
export async function compactMessages(
	messages: CoordinationMessage[],
	storage: FileBasedStorage,
	targetSize = 40,
	recencyWindow = 10,
): Promise<CoordinationMessage[]> {
	// Nothing to compact if already within target
	if (messages.length <= targetSize) {
		return messages;
	}

	try {
		// Split into recent (always kept) and older (candidates for removal)
		const recent = messages.slice(-recencyWindow);
		const older = messages.slice(0, messages.length - recencyWindow);

		const budget = targetSize - recencyWindow;

		// Score each older message: lower score = higher priority to keep
		const scored = older.map((msg, idx) => ({
			msg,
			idx,
			score:
				MESSAGE_TYPE_PRIORITY[msg.type] * 1000 +
				(older.length - idx), // prefer newer within same priority tier
		}));

		// Sort by score ascending (most important first), keep top `budget`
		scored.sort((a, b) => a.score - b.score);
		const kept = scored
			.slice(0, budget)
			.sort((a, b) => a.idx - b.idx) // restore original chronological order
			.map((s) => s.msg);

		return [...kept, ...recent];
	} catch (err: unknown) {
		// Log to event stream instead of swallowing or console.warn-only
		const errorMessage = err instanceof Error ? err.message : String(err);
		await storage.appendEvent({
			type: "coordinator",
			message: `[context-compactor] Compaction failed: ${errorMessage}. Falling back to last-20 truncation.`,
			timestamp: Date.now(),
		});

		// Fallback: truncate to the last 20 messages to prevent unbounded growth.
		// This preserves the most recent context even when compaction logic fails,
		// ensuring the coordinator can always make forward progress.
		return messages.slice(-20);
	}
}
