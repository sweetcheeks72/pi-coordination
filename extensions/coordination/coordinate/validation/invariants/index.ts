import type { ObservabilityData, InvariantChecker, InvariantResult, ValidationStrictness } from "../types.js";
import { sessionLifecycleInvariant } from "./session.js";
import { workerLifecycleInvariant } from "./workers.js";
import { contractFulfillmentInvariant } from "./contracts.js";
import { costAccountingInvariant } from "./costs.js";
import { reservationIntegrityInvariant } from "./reservations.js";
import { causalityValidityInvariant } from "./causality.js";
import { phaseOrderingInvariant } from "./phases.js";
import { noOrphanedResourcesInvariant } from "./resources.js";

export const ALL_INVARIANTS: InvariantChecker[] = [
	sessionLifecycleInvariant,
	workerLifecycleInvariant,
	contractFulfillmentInvariant,
	costAccountingInvariant,
	reservationIntegrityInvariant,
	causalityValidityInvariant,
	phaseOrderingInvariant,
	noOrphanedResourcesInvariant,
];

export async function runAllInvariants(
	data: ObservabilityData,
	_strictness: ValidationStrictness,
): Promise<InvariantResult[]> {
	const results = await Promise.all(ALL_INVARIANTS.map((invariant) => invariant.check(data)));
	return results;
}

export {
	sessionLifecycleInvariant,
	workerLifecycleInvariant,
	contractFulfillmentInvariant,
	costAccountingInvariant,
	reservationIntegrityInvariant,
	causalityValidityInvariant,
	phaseOrderingInvariant,
	noOrphanedResourcesInvariant,
};
