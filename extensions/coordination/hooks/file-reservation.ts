/**
 * Output validation hook: File reservation enforcement.
 *
 * This extension blocks write/edit operations to files that the worker
 * hasn't reserved. It reads reservations from the coordination directory.
 *
 * Environment variables:
 * - PI_COORDINATION_DIR: Path to coordination directory (contains reservations.json)
 * - PI_AGENT_IDENTITY: Identity of the current worker
 *
 * Usage in agent frontmatter:
 * ```yaml
 * ---
 * name: coordination/worker
 * extensions: ../hooks/file-reservation.ts
 * ---
 * ```
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface FileReservation {
	id: string;
	agent: string;
	patterns: string[];
	exclusive: boolean;
	reason?: string;
	createdAt: number;
	expiresAt: number;
}

interface ReservationsFile {
	reservations: FileReservation[];
}

/**
 * Load reservations from the coordination directory.
 */
function loadReservations(coordDir: string): FileReservation[] {
	const reservationsPath = path.join(coordDir, "reservations.json");
	if (!fs.existsSync(reservationsPath)) {
		return [];
	}

	try {
		const content = fs.readFileSync(reservationsPath, "utf-8");
		const data = JSON.parse(content) as ReservationsFile;
		return data.reservations || [];
	} catch {
		return [];
	}
}

/**
 * Check if a file path matches any of the patterns.
 */
function matchesPattern(filePath: string, patterns: string[]): boolean {
	const normalizedPath = filePath.replace(/\\/g, "/");

	for (const pattern of patterns) {
		const normalizedPattern = pattern.replace(/\\/g, "/");

		// Exact match
		if (normalizedPath === normalizedPattern) {
			return true;
		}

		// Prefix match (directory pattern)
		if (normalizedPattern.endsWith("/") && normalizedPath.startsWith(normalizedPattern)) {
			return true;
		}

		// Glob-style pattern match (simple * wildcard)
		if (normalizedPattern.includes("*")) {
			const regex = new RegExp(
				"^" +
					normalizedPattern
						.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
						.replace(/\*/g, ".*") +
					"$"
			);
			if (regex.test(normalizedPath)) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Check if the current agent has a reservation for a file.
 */
function hasReservation(
	filePath: string,
	agentIdentity: string,
	reservations: FileReservation[]
): { hasReservation: boolean; conflictingAgent?: string } {
	const now = Date.now();
	const activeReservations = reservations.filter((r) => r.expiresAt > now);

	// Check if this agent has a reservation for this file
	for (const res of activeReservations) {
		if (res.agent === agentIdentity && matchesPattern(filePath, res.patterns)) {
			return { hasReservation: true };
		}
	}

	// Check if another agent has an exclusive reservation
	for (const res of activeReservations) {
		if (res.agent !== agentIdentity && res.exclusive && matchesPattern(filePath, res.patterns)) {
			return { hasReservation: false, conflictingAgent: res.agent };
		}
	}

	// No reservation found, but no conflict either (non-exclusive or untracked file)
	return { hasReservation: false };
}

export default function fileReservation(pi: ExtensionAPI): void {
	const coordDir = process.env.PI_COORDINATION_DIR;
	const agentIdentity = process.env.PI_AGENT_IDENTITY;

	// Only enforce reservations if in coordination context
	if (!coordDir || !agentIdentity) {
		console.log("[file-reservation] Not in coordination context, skipping reservation enforcement");
		return;
	}

	let reservations: FileReservation[] = [];
	let lastLoadTime = 0;
	const CACHE_TTL_MS = 5000; // Reload reservations every 5 seconds

	const getReservations = (): FileReservation[] => {
		const now = Date.now();
		if (now - lastLoadTime > CACHE_TTL_MS) {
			reservations = loadReservations(coordDir);
			lastLoadTime = now;
		}
		return reservations;
	};

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;

		// Only check file-modifying tools
		if (!["edit", "write"].includes(toolName)) {
			return;
		}

		const args = event.args as { path?: string; file_path?: string };
		const filePath = args.path || args.file_path;

		if (!filePath) {
			return;
		}

		const currentReservations = getReservations();
		const result = hasReservation(filePath, agentIdentity, currentReservations);

		if (!result.hasReservation && result.conflictingAgent) {
			// Block the operation
			console.warn(
				`[file-reservation] Blocked ${toolName} on ${filePath} - reserved by ${result.conflictingAgent}`
			);

			return {
				intercepted: true,
				content: [
					{
						type: "text",
						text: `ERROR: Cannot ${toolName} ${filePath} - file is reserved by ${result.conflictingAgent}. Use file_reservations tool to request access.`,
					},
				],
			};
		}

		// Allow the operation
		return undefined;
	});
}
