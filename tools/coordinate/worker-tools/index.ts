import { randomUUID } from "node:crypto";
import type { CustomAgentTool, CustomToolFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { FileBasedStorage } from "../state.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const factory: CustomToolFactory = (_pi) => {
	const coordDir = process.env.PI_COORDINATION_DIR;
	const identity = process.env.PI_AGENT_IDENTITY;
	const workerId = process.env.PI_WORKER_ID;

	if (!coordDir || !identity || !workerId) {
		throw new Error("Worker tools require PI_COORDINATION_DIR, PI_AGENT_IDENTITY, and PI_WORKER_ID environment variables");
	}

	const storage = new FileBasedStorage(coordDir);
	let lastMessageCheck = Date.now();

	const tools: CustomAgentTool[] = [
		{
			name: "send_message",
			label: "Send Message",
			description: "Send a message to another agent or the coordinator",
			parameters: Type.Object({
				to: Type.String({ description: "Recipient: worker identity, 'coordinator', or 'all'" }),
				content: Type.String({ description: "Message content" }),
				type: Type.String({ description: "Message type: 'handover', 'clarification', 'response', 'status', or 'conflict'" }),
			}),
			async execute(_toolCallId, params) {
				const msg = {
					id: randomUUID(),
					from: identity,
					to: params.to,
					type: params.type as "handover" | "clarification" | "response" | "status" | "conflict",
					content: params.content,
					timestamp: Date.now(),
				};

				await storage.sendMessage(msg);

				return {
					content: [{ type: "text", text: `Message sent to ${params.to}` }],
				};
			},
		},

		{
			name: "check_messages",
			label: "Check Messages",
			description: "Check inbox for new messages addressed to this worker",
			parameters: Type.Object({
				since: Type.Optional(Type.Number({ description: "Only get messages since this timestamp" })),
			}),
			async execute(_toolCallId, params) {
				const messages = await storage.getMessages({
					to: identity,
					since: params.since || lastMessageCheck,
				});
				lastMessageCheck = Date.now();

				if (messages.length === 0) {
					return {
						content: [{ type: "text", text: "No new messages" }],
						details: { messages: [] },
					};
				}

				const formatted = messages.map((m) => `[${m.from}] (${m.type}): ${m.content}`).join("\n\n");
				return {
					content: [{ type: "text", text: `${messages.length} new message(s):\n\n${formatted}` }],
					details: { messages },
				};
			},
		},

		{
			name: "reserve_files",
			label: "Reserve Files",
			description: "Reserve files for exclusive editing to prevent conflicts",
			parameters: Type.Object({
				patterns: Type.Array(Type.String(), { description: "File patterns to reserve (e.g., ['src/auth/**', 'src/types.ts'])" }),
				exclusive: Type.Boolean({ description: "If true, no other worker can touch these files" }),
				ttl: Type.Number({ description: "Reservation time-to-live in seconds" }),
				reason: Type.String({ description: "Why you need these files" }),
			}),
			async execute(_toolCallId, params) {
				const result = await storage.reserveFiles({
					id: randomUUID(),
					agent: identity,
					patterns: params.patterns,
					exclusive: params.exclusive,
					reason: params.reason,
					createdAt: Date.now(),
					expiresAt: Date.now() + params.ttl * 1000,
				});

				if (result.success) {
					return {
						content: [{ type: "text", text: `Reserved: ${params.patterns.join(", ")}` }],
						details: result,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Reservation conflict with ${result.conflict?.agent}:\n` +
								`Their patterns: ${result.conflict?.patterns.join(", ")}\n` +
								`Reason: ${result.conflict?.reason}\n` +
								`Expires in: ${Math.floor(((result.conflict?.expiresAt || 0) - Date.now()) / 1000)}s`,
						},
					],
					details: result,
					isError: true,
				};
			},
		},

		{
			name: "release_files",
			label: "Release Files",
			description: "Release file reservations when done editing",
			parameters: Type.Object({
				patterns: Type.Array(Type.String(), { description: "File patterns to release" }),
			}),
			async execute(_toolCallId, params) {
				await storage.releaseFiles(identity, params.patterns);

				return {
					content: [{ type: "text", text: `Released: ${params.patterns.join(", ")}` }],
				};
			},
		},

		{
			name: "signal_contract_complete",
			label: "Signal Contract Complete",
			description: "Signal that a contracted export/interface is ready for other workers",
			parameters: Type.Object({
				item: Type.String({ description: "Contract item name" }),
				signature: Type.Optional(Type.String({ description: "Actual signature/definition" })),
				file: Type.Optional(Type.String({ description: "File where it's defined" })),
			}),
			async execute(_toolCallId, params) {
				let waiters: string[] = [];

				const contract = await storage.updateContract(params.item, (c) => {
					if (!c) return undefined;
					waiters = c.waiters;
					return {
						...c,
						status: "ready",
						actualSignature: params.signature,
						file: params.file,
						completedAt: Date.now(),
					};
				});

				if (!contract) {
					return {
						content: [{ type: "text", text: `Contract not found: ${params.item}` }],
						isError: true,
					};
				}

				for (const waiter of waiters) {
					await storage.sendMessage({
						id: randomUUID(),
						from: identity,
						to: waiter,
						type: "status",
						content: `Contract ready: ${params.item}${params.file ? ` in ${params.file}` : ""}`,
						timestamp: Date.now(),
					});
				}

				return {
					content: [{ type: "text", text: `Contract ${params.item} marked ready, notified ${waiters.length} waiter(s)` }],
				};
			},
		},

		{
			name: "complete_task",
			label: "Complete Task",
			description: "Signal that this worker has completed all assigned steps. IMPORTANT: After calling this, do NOT generate any more responses.",
			parameters: Type.Object({
				result: Type.String({ description: "Summary of what was accomplished" }),
				filesModified: Type.Optional(Type.Array(Type.String(), { description: "List of modified files" })),
			}),
			async execute(_toolCallId, params) {
				await storage.updateWorkerState(workerId, (w) => ({
					...w,
					status: "complete",
					completedAt: Date.now(),
					completedSteps: w.assignedSteps,
					currentStep: null,
					currentTool: null,
					currentFile: null,
				}));

				await storage.sendMessage({
					id: randomUUID(),
					from: identity,
					to: "coordinator",
					type: "status",
					content: `Completed: ${params.result}`,
					timestamp: Date.now(),
				});

				await storage.releaseFiles(identity, ["**"]);

				await storage.appendEvent({
					type: "worker_completed",
					workerId,
					timestamp: Date.now(),
				});

				return {
					content: [{ type: "text", text: "Task completed." }],
					details: { result: params.result, filesModified: params.filesModified },
				};
			},
		},

		{
			name: "escalate_to_user",
			label: "Escalate to User",
			description: "Ask the user a question when you need clarification",
			parameters: Type.Object({
				question: Type.String({ description: "Question to ask" }),
				options: Type.Array(Type.String(), { description: "Available options" }),
				timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 60)" })),
				defaultOption: Type.Optional(Type.Number({ description: "Index of default option (0-based)" })),
			}),
			async execute(_toolCallId, params) {
				const id = randomUUID();
				const timeout = params.timeout || 60;

				await storage.appendEscalation({
					id,
					from: identity,
					question: params.question,
					options: params.options,
					timeout,
					defaultOption: params.defaultOption,
					createdAt: Date.now(),
				});

				const deadline = Date.now() + timeout * 1000;
				while (Date.now() < deadline) {
					const response = await storage.getEscalationResponse(id);
					if (response) {
						return {
							content: [{ type: "text", text: `User chose: ${response.choice}${response.wasTimeout ? " (auto-selected)" : ""}` }],
							details: response,
						};
					}
					await sleep(1000);
				}

				const choice = params.options[params.defaultOption || 0];
				await storage.writeEscalationResponse({
					id,
					choice,
					wasTimeout: true,
					respondedAt: Date.now(),
				});

				return {
					content: [{ type: "text", text: `Timeout - using default: ${choice}` }],
					details: { id, choice, wasTimeout: true, respondedAt: Date.now() },
				};
			},
		},

		{
			name: "wait_for_contract",
			label: "Wait for Contract",
			description: "Wait for a contract to be ready. Blocks until the contract is signaled complete.",
			parameters: Type.Object({
				item: Type.String({ description: "Contract item name to wait for" }),
				timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300)" })),
			}),
			async execute(_toolCallId, params) {
				const timeout = params.timeout || 300;
				const deadline = Date.now() + timeout * 1000;

				const state = await storage.getState();
				const contract = state.contracts[params.item];
				if (!contract) {
					return {
						content: [{ type: "text", text: `Contract not found: ${params.item}` }],
						isError: true,
					};
				}

				await storage.updateWorkerState(workerId, (s) => ({
					...s,
					status: "waiting",
					waitingFor: { identity: contract.provider, item: params.item },
				}));

				await storage.appendEvent({
					type: "waiting",
					workerId,
					waitingFor: contract.provider,
					item: params.item,
					timestamp: Date.now(),
				});

				while (Date.now() < deadline) {
					const currentState = await storage.getState();
					const currentContract = currentState.contracts[params.item];
					if (currentContract?.status === "ready") {
						await storage.updateWorkerState(workerId, (s) => ({
							...s,
							status: "working",
							waitingFor: null,
						}));
						await storage.appendEvent({
							type: "contract_received",
							workerId,
							from: currentContract.provider,
							item: params.item,
							timestamp: Date.now(),
						});
						return {
							content: [{ type: "text", text: `Contract ready: ${params.item}` }],
							details: { contract: currentContract },
						};
					}
					await sleep(1000);
				}

				await storage.updateWorkerState(workerId, (s) => ({
					...s,
					status: "blocked",
					waitingFor: null,
					currentTool: null,
					currentFile: null,
					blockers: [...s.blockers, `Timeout waiting for contract: ${params.item}`],
				}));

				await storage.appendEvent({
					type: "worker_failed",
					workerId,
					error: `Timeout waiting for contract: ${params.item}`,
					timestamp: Date.now(),
				});

				return {
					content: [{ type: "text", text: `Timeout waiting for contract: ${params.item}` }],
					isError: true,
				};
			},
		},

		{
			name: "update_step",
			label: "Update Step",
			description: "Update the current step being worked on",
			parameters: Type.Object({
				step: Type.Number({ description: "Step number now being worked on" }),
				status: Type.Optional(Type.String({ description: "Status update message" })),
			}),
			async execute(_toolCallId, params) {
				await storage.updateWorkerState(workerId, (w) => {
					const completedSteps = [...w.completedSteps];
					if (w.currentStep !== null && !completedSteps.includes(w.currentStep)) {
						completedSteps.push(w.currentStep);
					}
					return {
						...w,
						completedSteps,
						currentStep: params.step,
					};
				});

				if (params.status) {
					await storage.appendEvent({
						type: "coordinator",
						message: `Step ${params.step}: ${params.status}`,
						timestamp: Date.now(),
					});
				}

				return {
					content: [{ type: "text", text: `Now working on step ${params.step}` }],
				};
			},
		},
	];

	return tools;
};

export default factory;
