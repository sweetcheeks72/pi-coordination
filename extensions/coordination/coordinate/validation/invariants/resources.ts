import type { InvariantChecker, InvariantResult, ObservabilityData } from "../types.js";

export const noOrphanedResourcesInvariant: InvariantChecker = {
	name: "No Orphaned Resources",
	category: "soft",

	async check(data: ObservabilityData): Promise<InvariantResult> {
		const { resources } = data;

		if (resources.length === 0) {
			return {
				name: this.name,
				category: this.category,
				passed: true,
				message: "No resource events recorded",
				details: { noResourceEvents: true },
			};
		}

		const issues: string[] = [];

		const resourceStates = new Map<string, { type: string; owner: string; event: string }>();

		for (const event of resources) {
			const key = `${event.resourceType}:${event.resourceId}`;

			switch (event.event) {
				case "created":
					resourceStates.set(key, {
						type: event.resourceType,
						owner: event.owner,
						event: "created",
					});
					break;

				case "released":
					if (resourceStates.has(key)) {
						resourceStates.delete(key);
					} else {
						issues.push(`Resource ${key} released without being created`);
					}
					break;

				case "leaked":
					issues.push(`Resource ${key} was explicitly marked as leaked`);
					resourceStates.delete(key);
					break;

				case "orphaned":
					issues.push(`Resource ${key} was explicitly marked as orphaned`);
					resourceStates.delete(key);
					break;

				case "updated":
					break;
			}
		}

		for (const [key, state] of resourceStates) {
			if (state.event === "created") {
				issues.push(`Resource ${key} (owned by ${state.owner}) was never released`);
			}
		}

		const totalCreated = resources.filter((r) => r.event === "created").length;
		const totalReleased = resources.filter((r) => r.event === "released").length;
		const totalLeaked = resources.filter((r) => r.event === "leaked").length;
		const totalOrphaned = resources.filter((r) => r.event === "orphaned").length;

		const passed = issues.length === 0;

		return {
			name: this.name,
			category: this.category,
			passed,
			message: passed
				? `All ${totalCreated} resources properly released`
				: issues.join("; "),
			details: {
				created: totalCreated,
				released: totalReleased,
				leaked: totalLeaked,
				orphaned: totalOrphaned,
				unreleased: resourceStates.size,
				issues: passed ? undefined : issues,
			},
		};
	},
};
