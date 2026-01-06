import type { InvariantChecker, InvariantResult, ObservabilityData } from "../types.js";
import { getEventsByType } from "../loader.js";

export const reservationIntegrityInvariant: InvariantChecker = {
	name: "Reservation Integrity",
	category: "hard",

	async check(data: ObservabilityData): Promise<InvariantResult> {
		const requestedEvents = getEventsByType(data.events, "reservation_requested");
		const grantedEvents = getEventsByType(data.events, "reservation_granted");
		const deniedEvents = getEventsByType(data.events, "reservation_denied");
		const transferredEvents = getEventsByType(data.events, "reservation_transferred");
		const releasedEvents = getEventsByType(data.events, "reservation_released");

		const issues: string[] = [];

		const grantedIds = new Set(grantedEvents.map((e) => e.reservationId));
		const deniedIds = new Set(deniedEvents.map((e) => e.reservationId));
		const releasedIds = new Set(releasedEvents.map((e) => e.reservationId));
		const transferredIds = new Set(transferredEvents.map((e) => e.reservationId));

		for (const event of requestedEvents) {
			const { reservationId } = event;
			const wasGranted = grantedIds.has(reservationId);
			const wasDenied = deniedIds.has(reservationId);

			if (!wasGranted && !wasDenied) {
				issues.push(`Reservation ${reservationId} was requested but never granted or denied`);
			}

			if (wasGranted && wasDenied) {
				issues.push(`Reservation ${reservationId} was both granted and denied`);
			}
		}

		for (const event of grantedEvents) {
			const { reservationId } = event;
			const wasReleased = releasedIds.has(reservationId);
			const wasTransferred = transferredIds.has(reservationId);

			if (!wasReleased && !wasTransferred) {
				issues.push(`Reservation ${reservationId} was granted but never released or transferred`);
			}
		}

		const activeReservations = new Map<string, { agent: string; patterns: string[]; exclusive: boolean; grantedAt: number }>();

		const sortedRequestedEvents = [...requestedEvents].sort((a, b) => a.timestamp - b.timestamp);

		for (const event of sortedRequestedEvents) {
			const grantEvent = grantedEvents.find((g) => g.reservationId === event.reservationId);
			if (!grantEvent) continue;

			const releaseEvent = releasedEvents.find((r) => r.reservationId === event.reservationId);
			const releaseTime = releaseEvent?.timestamp ?? Infinity;

			for (const [existingId, existing] of activeReservations) {
				const existingReleaseEvent = releasedEvents.find((r) => r.reservationId === existingId);
				const existingReleaseTime = existingReleaseEvent?.timestamp ?? Infinity;

				if (grantEvent.timestamp >= existingReleaseTime) continue;
				if (existing.grantedAt >= releaseTime) continue;

				if (event.exclusive || existing.exclusive) {
					const patternOverlap = event.patterns.some((p) =>
						existing.patterns.some((ep) => patternsOverlap(p, ep)),
					);

					if (patternOverlap) {
						issues.push(`Conflicting exclusive reservations: ${event.reservationId} and ${existingId}`);
					}
				}
			}

			activeReservations.set(event.reservationId, {
				agent: event.actor,
				patterns: event.patterns,
				exclusive: event.exclusive,
				grantedAt: grantEvent.timestamp,
			});

			if (releaseEvent) {
				activeReservations.delete(event.reservationId);
			}
		}

		const passed = issues.length === 0;

		return {
			name: this.name,
			category: this.category,
			passed,
			message: passed
				? `All ${grantedEvents.length} reservations properly managed`
				: issues.join("; "),
			details: {
				requested: requestedEvents.length,
				granted: grantedEvents.length,
				denied: deniedEvents.length,
				transferred: transferredEvents.length,
				released: releasedEvents.length,
				issues: passed ? undefined : issues,
			},
		};
	},
};

function patternsOverlap(a: string, b: string): boolean {
	if (a === b) return true;

	const aGlob = a.includes("*");
	const bGlob = b.includes("*");

	if (!aGlob && !bGlob) {
		return a === b;
	}

	if (aGlob && !bGlob) {
		return matchGlob(a, b);
	}
	if (bGlob && !aGlob) {
		return matchGlob(b, a);
	}

	const aPrefix = a.replace(/\*.*$/, "");
	const bPrefix = b.replace(/\*.*$/, "");
	return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
}

function escapeRegex(str: string): string {
	return str.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function matchGlob(pattern: string, filePath: string): boolean {
	const escaped = escapeRegex(pattern).replace(/\\\*/g, ".*");
	const regex = new RegExp("^" + escaped + "$");
	return regex.test(filePath);
}
