import type { InvariantChecker, InvariantResult, ObservabilityData } from "../types.js";
import { getEventsByType } from "../loader.js";
import type { PipelinePhase } from "../../types.js";

const PHASE_ORDER: PipelinePhase[] = ["scout", "coordinator", "workers", "review", "fixes", "complete"];

export const phaseOrderingInvariant: InvariantChecker = {
	name: "Phase Ordering",
	category: "hard",

	async check(data: ObservabilityData): Promise<InvariantResult> {
		const startedEvents = getEventsByType(data.events, "phase_started");
		const completedEvents = getEventsByType(data.events, "phase_completed");

		const issues: string[] = [];

		const phaseStartTimes = new Map<PipelinePhase, number>();
		const phaseEndTimes = new Map<PipelinePhase, number>();

		for (const event of startedEvents) {
			const existing = phaseStartTimes.get(event.phase);
			if (existing === undefined || event.timestamp < existing) {
				phaseStartTimes.set(event.phase, event.timestamp);
			}
		}

		for (const event of completedEvents) {
			const existing = phaseEndTimes.get(event.phase);
			if (existing === undefined || event.timestamp > existing) {
				phaseEndTimes.set(event.phase, event.timestamp);
			}
		}

		for (const event of startedEvents) {
			const { phase } = event;
			const completedEvent = completedEvents.find(
				(c) => c.phase === phase && c.timestamp > event.timestamp,
			);

			if (!completedEvent && phase !== "complete" && phase !== "failed") {
				const laterStart = startedEvents.find(
					(s) => s.phase === phase && s.timestamp > event.timestamp,
				);
				if (!laterStart) {
					issues.push(`Phase ${phase} started but never completed`);
				}
			}
		}

		for (let i = 0; i < PHASE_ORDER.length - 1; i++) {
			const currentPhase = PHASE_ORDER[i];
			const nextPhase = PHASE_ORDER[i + 1];

			const currentEnd = phaseEndTimes.get(currentPhase);
			const nextStart = phaseStartTimes.get(nextPhase);

			if (currentEnd !== undefined && nextStart !== undefined) {
				if (nextStart < currentEnd) {
					issues.push(
						`Phase ${nextPhase} started (${nextStart}) before ${currentPhase} completed (${currentEnd})`,
					);
				}
			}
		}

		const observedPhases = new Set<PipelinePhase>();
		for (const event of startedEvents) {
			observedPhases.add(event.phase);
		}

		const passed = issues.length === 0;

		return {
			name: this.name,
			category: this.category,
			passed,
			message: passed
				? `Phases executed in correct order: ${Array.from(observedPhases).join(" -> ")}`
				: issues.join("; "),
			details: {
				observedPhases: Array.from(observedPhases),
				phaseStartTimes: Object.fromEntries(phaseStartTimes),
				phaseEndTimes: Object.fromEntries(phaseEndTimes),
				issues: passed ? undefined : issues,
			},
		};
	},
};
