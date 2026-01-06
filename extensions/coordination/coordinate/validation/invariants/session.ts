import type { InvariantChecker, InvariantResult, ObservabilityData } from "../types.js";
import { getEventsByType } from "../loader.js";

export const sessionLifecycleInvariant: InvariantChecker = {
	name: "Session Lifecycle",
	category: "hard",

	async check(data: ObservabilityData): Promise<InvariantResult> {
		const startedEvents = getEventsByType(data.events, "session_started");
		const completedEvents = getEventsByType(data.events, "session_completed");

		const issues: string[] = [];

		if (startedEvents.length === 0) {
			issues.push("No session_started event found");
		} else if (startedEvents.length > 1) {
			issues.push(`Multiple session_started events found (${startedEvents.length})`);
		}

		if (completedEvents.length === 0) {
			issues.push("No session_completed event found");
		} else if (completedEvents.length > 1) {
			issues.push(`Multiple session_completed events found (${completedEvents.length})`);
		}

		if (startedEvents.length === 1 && completedEvents.length === 1) {
			const started = startedEvents[0];
			const completed = completedEvents[0];

			if (completed.timestamp <= started.timestamp) {
				issues.push(`session_completed (${completed.timestamp}) is not after session_started (${started.timestamp})`);
			}

			if (!completed.summary) {
				issues.push("session_completed is missing summary");
			} else {
				const { summary } = completed;
				if (summary.status === undefined) issues.push("summary.status is missing");
				if (summary.duration === undefined) issues.push("summary.duration is missing");
				if (summary.totalCost === undefined) issues.push("summary.totalCost is missing");
			}
		}

		const passed = issues.length === 0;

		return {
			name: this.name,
			category: this.category,
			passed,
			message: passed
				? "Session started and completed normally with valid summary"
				: issues.join("; "),
			details: passed
				? { duration: completedEvents[0]?.summary?.duration }
				: { issues },
		};
	},
};
