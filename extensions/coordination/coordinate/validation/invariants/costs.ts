import type { InvariantChecker, InvariantResult, ObservabilityData } from "../types.js";
import { getEventsByType } from "../loader.js";

export const costAccountingInvariant: InvariantChecker = {
	name: "Cost Accounting",
	category: "soft",

	async check(data: ObservabilityData): Promise<InvariantResult> {
		const costEvents = getEventsByType(data.events, "cost_updated");
		const sessionCompleted = getEventsByType(data.events, "session_completed")[0];

		const issues: string[] = [];

		if (costEvents.length === 0) {
			return {
				name: this.name,
				category: this.category,
				passed: true,
				message: "No cost events recorded (may be expected for zero-cost run)",
				details: { noCostEvents: true },
			};
		}

		const lastCostEvent = costEvents[costEvents.length - 1];
		const { breakdown } = lastCostEvent;

		const phaseTotal = Object.values(breakdown.byPhase).reduce((sum, cost) => sum + cost, 0);
		const phaseDiff = Math.abs(phaseTotal - lastCostEvent.total);
		if (phaseDiff > 0.001) {
			issues.push(`byPhase costs (${phaseTotal.toFixed(4)}) don't sum to total (${lastCostEvent.total.toFixed(4)})`);
		}

		const workerTotal = Object.values(breakdown.byWorker).reduce((sum, cost) => sum + cost, 0);
		const workersPhase = breakdown.byPhase.workers || 0;
		const workerDiff = Math.abs(workerTotal - workersPhase);
		if (workerDiff > 0.001 && workerTotal > 0) {
			issues.push(`byWorker costs (${workerTotal.toFixed(4)}) don't match workers phase (${workersPhase.toFixed(4)})`);
		}

		if (sessionCompleted?.summary) {
			const reportedTotal = sessionCompleted.summary.totalCost;
			const trackedTotal = lastCostEvent.total;
			const sessionDiff = Math.abs(reportedTotal - trackedTotal);
			if (sessionDiff > 0.001) {
				issues.push(`session_completed.totalCost (${reportedTotal.toFixed(4)}) doesn't match tracked total (${trackedTotal.toFixed(4)})`);
			}
		}

		let runningTotal = 0;
		for (let i = 0; i < costEvents.length; i++) {
			const event = costEvents[i];
			runningTotal += event.delta;
			const diff = Math.abs(runningTotal - event.total);
			if (diff > 0.001) {
				issues.push(`Cost event ${i}: running total (${runningTotal.toFixed(4)}) doesn't match event total (${event.total.toFixed(4)})`);
				break;
			}
		}

		const passed = issues.length === 0;

		return {
			name: this.name,
			category: this.category,
			passed,
			message: passed
				? `Cost accounting verified: $${lastCostEvent.total.toFixed(4)} total across ${costEvents.length} updates`
				: issues.join("; "),
			details: {
				totalCost: lastCostEvent.total,
				costEvents: costEvents.length,
				byPhase: breakdown.byPhase,
				byWorker: breakdown.byWorker,
				issues: passed ? undefined : issues,
			},
		};
	},
};
