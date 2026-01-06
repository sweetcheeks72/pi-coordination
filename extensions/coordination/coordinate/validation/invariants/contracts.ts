import type { InvariantChecker, InvariantResult, ObservabilityData } from "../types.js";
import { getEventsByType } from "../loader.js";

export const contractFulfillmentInvariant: InvariantChecker = {
	name: "Contract Fulfillment",
	category: "hard",

	async check(data: ObservabilityData): Promise<InvariantResult> {
		const createdEvents = getEventsByType(data.events, "contract_created");
		const signaledEvents = getEventsByType(data.events, "contract_signaled");
		const waitingEvents = getEventsByType(data.events, "contract_waiting");
		const receivedEvents = getEventsByType(data.events, "contract_received");

		const issues: string[] = [];

		const signaledContracts = new Set(signaledEvents.map((e) => e.contractId));
		const receivedByWaiter = new Map<string, Set<string>>();

		for (const event of receivedEvents) {
			if (!receivedByWaiter.has(event.contractId)) {
				receivedByWaiter.set(event.contractId, new Set());
			}
			receivedByWaiter.get(event.contractId)!.add(event.waiter);
		}

		for (const event of createdEvents) {
			const { contract } = event;

			if (contract.waiters.length > 0 && !signaledContracts.has(contract.id)) {
				issues.push(`Contract ${contract.id} (${contract.item}) has waiters but was never signaled`);
			}
		}

		for (const event of waitingEvents) {
			const { contractId, waiter } = event;
			const receivers = receivedByWaiter.get(contractId);

			if (!receivers || !receivers.has(waiter)) {
				const hasTimeoutError = data.errors.some(
					(e) => e.category === "contract_timeout" && e.relatedContractId === contractId,
				);

				if (!hasTimeoutError) {
					issues.push(`Contract ${contractId} waiter ${waiter} never received signal and no timeout error`);
				}
			}
		}

		for (const event of signaledEvents) {
			const created = createdEvents.find((c) => c.contract.id === event.contractId);
			if (!created) {
				issues.push(`Contract ${event.contractId} was signaled but never created`);
			}
		}

		const totalContracts = createdEvents.length;
		const totalSignaled = signaledEvents.length;
		const totalWaitEvents = waitingEvents.length;
		const totalReceived = receivedEvents.length;

		const passed = issues.length === 0;

		return {
			name: this.name,
			category: this.category,
			passed,
			message: passed
				? `All ${totalContracts} contracts fulfilled (${totalSignaled} signaled, ${totalReceived} received)`
				: issues.join("; "),
			details: {
				created: totalContracts,
				signaled: totalSignaled,
				waitEvents: totalWaitEvents,
				received: totalReceived,
				issues: passed ? undefined : issues,
			},
		};
	},
};
