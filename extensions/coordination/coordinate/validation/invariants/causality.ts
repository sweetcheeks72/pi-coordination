import type { InvariantChecker, InvariantResult, ObservabilityData } from "../types.js";

export const causalityValidityInvariant: InvariantChecker = {
	name: "Causality Validity",
	category: "soft",

	async check(data: ObservabilityData): Promise<InvariantResult> {
		const { causalLinks, events } = data;

		if (causalLinks.length === 0) {
			return {
				name: this.name,
				category: this.category,
				passed: true,
				message: "No causal links recorded",
				details: { noCausalLinks: true },
			};
		}

		const issues: string[] = [];
		const eventIds = new Set(events.map((e) => e.id));
		const eventTimestamps = new Map(events.map((e) => [e.id, e.timestamp]));

		for (const link of causalLinks) {
			if (!eventIds.has(link.cause.eventId)) {
				issues.push(`Causal link ${link.id}: cause event ${link.cause.eventId} not found`);
				continue;
			}

			if (!eventIds.has(link.effect.eventId)) {
				issues.push(`Causal link ${link.id}: effect event ${link.effect.eventId} not found`);
				continue;
			}

			const causeTime = eventTimestamps.get(link.cause.eventId)!;
			const effectTime = eventTimestamps.get(link.effect.eventId)!;

			if (effectTime < causeTime) {
				issues.push(
					`Causal link ${link.id}: effect (${effectTime}) occurs before cause (${causeTime})`,
				);
			}
		}

		const linksByEffect = new Map<string, string[]>();
		for (const link of causalLinks) {
			const causes = linksByEffect.get(link.effect.eventId) || [];
			causes.push(link.cause.eventId);
			linksByEffect.set(link.effect.eventId, causes);
		}

		const visited = new Set<string>();
		const inPath = new Set<string>();

		function hasCycle(eventId: string): boolean {
			if (inPath.has(eventId)) return true;
			if (visited.has(eventId)) return false;

			visited.add(eventId);
			inPath.add(eventId);

			const causes = linksByEffect.get(eventId) || [];
			for (const cause of causes) {
				if (hasCycle(cause)) return true;
			}

			inPath.delete(eventId);
			return false;
		}

		for (const link of causalLinks) {
			visited.clear();
			inPath.clear();
			if (hasCycle(link.effect.eventId)) {
				issues.push(`Circular causality detected involving event ${link.effect.eventId}`);
				break;
			}
		}

		const passed = issues.length === 0;

		return {
			name: this.name,
			category: this.category,
			passed,
			message: passed
				? `All ${causalLinks.length} causal links are valid`
				: issues.join("; "),
			details: {
				totalLinks: causalLinks.length,
				issues: passed ? undefined : issues,
			},
		};
	},
};
