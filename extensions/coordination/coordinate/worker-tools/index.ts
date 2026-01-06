import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { FileBasedStorage } from "../state.js";
import { createWorkerObservability } from "../observability/index.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerWorkerEventHandlers(
	pi: ExtensionAPI,
	storage: FileBasedStorage,
	identity: string,
	workerId: string,
): void {
	pi.on("tool_call", async (event) => {
		const { toolName, input } = event;

		if (toolName === "edit" || toolName === "write") {
			const filePath = input.path as string | undefined;
			if (filePath) {
				const reservation = await storage.checkReservation(filePath);
				if (reservation && reservation.agent !== identity && reservation.exclusive) {
					const expiresIn = Math.max(0, Math.floor((reservation.expiresAt - Date.now()) / 1000));
					return {
						block: true,
						reason:
							`File exclusively reserved by ${reservation.agent}: ${filePath}\n` +
							`Reason: ${reservation.reason}\n` +
							`Expires in: ${expiresIn}s\n\n` +
							`Options:\n` +
							`- Wait for the reservation to expire\n` +
							`- Send a message to ${reservation.agent} requesting early release\n` +
							`- Work on different files that aren't reserved`,
					};
				}
			}
		}

		const filePath = (toolName === "edit" || toolName === "write" || toolName === "read")
			? (input.path as string | undefined) ?? null
			: null;

		try {
			await storage.updateWorkerState(workerId, (s) => ({
				...s,
				currentTool: toolName,
				currentFile: filePath,
			}));

			await storage.appendEvent({
				type: "tool_call",
				workerId,
				tool: toolName,
				file: filePath ?? undefined,
				timestamp: Date.now(),
			});
		} catch {}
	});

	pi.on("tool_result", async (event) => {
		const filePath = (event.toolName === "edit" || event.toolName === "write" || event.toolName === "read")
			? (event.input.path as string | undefined) ?? undefined
			: undefined;

		try {
			await storage.appendEvent({
				type: "tool_result",
				workerId,
				tool: event.toolName,
				file: filePath,
				success: !event.isError,
				timestamp: Date.now(),
			});

			const isFileOp = (event.toolName === "edit" || event.toolName === "write") && !event.isError;

			await storage.updateWorkerState(workerId, (s) => ({
				...s,
				currentTool: null,
				currentFile: filePath ?? s.currentFile,
				filesModified: isFileOp && filePath
					? [...new Set([...s.filesModified, filePath])]
					: s.filesModified,
			}));
		} catch {}
	});

	pi.on("turn_end", async (event) => {
		if (event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			const usage = msg.usage;
			if (usage) {
				try {
					await storage.updateWorkerState(workerId, (state) => ({
						...state,
						usage: {
							input: state.usage.input + usage.input,
							output: state.usage.output + usage.output,
							cost: state.usage.cost + usage.cost.total,
							turns: state.usage.turns + 1,
						},
					}));
				} catch {}
			}
		}
	});

	pi.on("agent_end", async () => {
		try {
			await storage.updateWorkerState(workerId, (s) => ({
				...s,
				completedAt: s.completedAt ?? Date.now(),
			}));
		} catch {}
	});
}

export function registerWorkerTools(pi: ExtensionAPI): void {
	const coordDir = process.env.PI_COORDINATION_DIR;
	const identity = process.env.PI_AGENT_IDENTITY;
	const workerId = process.env.PI_WORKER_ID;

	if (!coordDir || !identity || !workerId) {
		throw new Error("Worker tools require PI_COORDINATION_DIR, PI_AGENT_IDENTITY, and PI_WORKER_ID environment variables");
	}

	const storage = new FileBasedStorage(coordDir);
	let obs: ReturnType<typeof createWorkerObservability> | null = null;
	const getObs = (ctx: ExtensionContext) => {
		if (!obs) {
			obs = createWorkerObservability(coordDir, process.env.PI_TRACE_ID, identity, ctx.cwd);
		}
		return obs;
	};
	let lastMessageCheck = Date.now();

	registerWorkerEventHandlers(pi, storage, identity, workerId);

	const tools: ToolDefinition[] = [
		{
			name: "send_message",
			label: "Send Message",
			description: "Send a message to another agent or the coordinator",
			parameters: Type.Object({
				to: Type.String({ description: "Recipient: worker identity, 'coordinator', or 'all'" }),
				content: Type.String({ description: "Message content" }),
				type: Type.String({ description: "Message type: 'handover', 'clarification', 'response', 'status', or 'conflict'" }),
			}),
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
				const msgId = randomUUID();
				const msgType = params.type as "handover" | "clarification" | "response" | "status" | "conflict";
				const msg = {
					id: msgId,
					from: identity,
					to: params.to,
					type: msgType,
					content: params.content,
					timestamp: Date.now(),
				};

				await storage.sendMessage(msg);

				await obs?.events.emit({
					type: "message_sent",
					messageId: msgId,
					from: identity,
					to: params.to,
					messageType: msgType,
				});

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
			async execute(_toolCallId, params, _onUpdate, _ctx) {
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
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
				const reservationId = randomUUID();

				await obs?.events.emit({
					type: "reservation_requested",
					reservationId,
					patterns: params.patterns,
					exclusive: params.exclusive,
				});

				const result = await storage.reserveFiles({
					id: reservationId,
					agent: identity,
					patterns: params.patterns,
					exclusive: params.exclusive,
					reason: params.reason,
					createdAt: Date.now(),
					expiresAt: Date.now() + params.ttl * 1000,
				});

				if (result.success) {
					await obs?.events.emit({
						type: "reservation_granted",
						reservationId,
					});

					return {
						content: [{ type: "text", text: `Reserved: ${params.patterns.join(", ")}` }],
						details: result,
					};
				}

				await obs?.events.emit({
					type: "reservation_denied",
					reservationId,
					conflict: {
						agent: result.conflict?.agent || "unknown",
						patterns: result.conflict?.patterns || [],
					},
				});

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
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
				const reservations = await storage.getActiveReservations();
				const myReservations = reservations.filter(r => r.agent === identity);

				await storage.releaseFiles(identity, params.patterns);

				for (const res of myReservations) {
					await obs?.events.emit({
						type: "reservation_released",
						reservationId: res.id,
					});
				}

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
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
				let waiters: string[] = [];
				let contractId: string | undefined;

				const contract = await storage.updateContract(params.item, (c) => {
					if (!c) return undefined;
					waiters = c.waiters;
					contractId = c.id;
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

				await obs?.events.emit({
					type: "contract_signaled",
					contractId: contractId || params.item,
					provider: identity,
					signature: params.signature,
				});

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
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
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

				const reservations = await storage.getActiveReservations();
				const myReservations = reservations.filter(r => r.agent === identity);

				await storage.releaseFiles(identity, ["**"]);

				for (const res of myReservations) {
					await obs?.events.emit({
						type: "reservation_released",
						reservationId: res.id,
					});
				}

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
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
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

				await obs?.events.emit({
					type: "escalation_created",
					escalationId: id,
					question: params.question,
					options: params.options,
					timeout,
				});

				const deadline = Date.now() + timeout * 1000;
				while (Date.now() < deadline) {
					const response = await storage.getEscalationResponse(id);
					if (response) {
						await obs?.events.emit({
							type: "escalation_responded",
							escalationId: id,
							choice: response.choice,
							wasTimeout: false,
						});

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

				await obs?.events.emit({
					type: "escalation_responded",
					escalationId: id,
					choice,
					wasTimeout: true,
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
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
				const timeout = params.timeout || 300;
				const deadline = Date.now() + timeout * 1000;
				const waitStartTime = Date.now();

				const state = await storage.getState();
				const contract = state.contracts[params.item];
				if (!contract) {
					return {
						content: [{ type: "text", text: `Contract not found: ${params.item}` }],
						isError: true,
					};
				}

				await obs?.events.emit({
					type: "contract_waiting",
					contractId: contract.id,
					waiter: identity,
				});

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

						const waitDuration = Date.now() - waitStartTime;
						await obs?.events.emit({
							type: "contract_received",
							contractId: currentContract.id,
							waiter: identity,
							waitDuration,
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

				await obs?.errors.capture(
					new Error(`Timeout waiting for contract: ${params.item}`),
					{
						category: "contract_timeout",
						severity: "error",
						actor: identity,
						phase: "workers",
						spanId: "root",
						recoverable: false,
						relatedWorkerId: workerId,
						relatedContractId: contract.id,
					},
				);

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
			async execute(_toolCallId, params, _onUpdate, _ctx) {
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

		{
			name: "report_deviation",
			label: "Report Deviation",
			description: "Report when you need to deviate from the plan approach (not scope)",
			parameters: Type.Object({
				deviation: Type.String({ description: "What you're changing from the plan" }),
				reason: Type.String({ description: "Why this deviation is necessary" }),
				affectsOthers: Type.Boolean({ description: "Could this affect other workers?" }),
			}),
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
				const deviationObj = {
					description: params.deviation,
					reason: params.reason,
					timestamp: Date.now(),
				};

				await storage.updateWorkerState(workerId, (s) => ({
					...s,
					deviations: [...(s.deviations || []), deviationObj],
				}));

				await obs?.events.emit({
					type: "deviation_reported",
					workerId,
					deviation: deviationObj,
					affectsOthers: params.affectsOthers,
				});

				if (params.affectsOthers) {
					await storage.sendMessage({
						id: randomUUID(),
						from: identity,
						to: "coordinator",
						type: "status",
						content: `DEVIATION (affects others): ${params.deviation}\nReason: ${params.reason}`,
						timestamp: Date.now(),
					});
				}

				return {
					content: [{ type: "text", text: "Deviation recorded" }],
				};
			},
		},

		{
			name: "read_plan",
			label: "Read Plan",
			description: "Read the full implementation plan (if not already in your context)",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _onUpdate, _ctx) {
				const state = await storage.getState();
				const content = await fs.readFile(state.planPath, "utf-8");
				return {
					content: [{ type: "text", text: content }],
				};
			},
		},

		{
			name: "add_discovered_task",
			label: "Add Discovered Task",
			description: "Add a task you discovered during implementation. It will be reviewed by the planner before becoming claimable.",
			parameters: Type.Object({
				id: Type.String({ description: "Unique task ID (e.g., 'TASK-DISC-01')" }),
				description: Type.String({ description: "What needs to be done" }),
				priority: Type.Number({ description: "Priority (0=critical, 1=high, 2=medium, 3=low)" }),
				files: Type.Optional(Type.Array(Type.String(), { description: "Files that need modification" })),
				dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this depends on" })),
				reason: Type.String({ description: "Why this task is needed" }),
			}),
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
				const { TaskQueueManager } = await import("../task-queue.js");
				const taskQueue = new TaskQueueManager(coordDir);

				const task = await taskQueue.addDiscoveredTask({
					id: params.id,
					description: params.description,
					priority: params.priority,
					files: params.files,
					dependsOn: params.dependsOn,
					discoveredFrom: workerId,
					acceptanceCriteria: [`Discovered: ${params.reason}`],
				});

				await obs?.events.emit({
					type: "task_discovered",
					taskId: task.id,
					discoveredBy: identity,
					discoveredFrom: workerId,
				});

				await storage.sendMessage({
					id: randomUUID(),
					from: identity,
					to: "coordinator",
					type: "status",
					content: `Discovered new task: ${params.id} - ${params.description}\nReason: ${params.reason}`,
					timestamp: Date.now(),
				});

				return {
					content: [{ type: "text", text: `Task ${params.id} added for planner review` }],
					details: { task },
				};
			},
		},

		{
			name: "share_discovery",
			label: "Share Discovery",
			description: "Share a learning or discovery with other workers",
			parameters: Type.Object({
				topic: Type.String({ description: "Topic/title of the discovery" }),
				content: Type.String({ description: "Details of what you discovered" }),
				importance: Type.String({ description: "Importance level: 'fyi', 'important', or 'critical'" }),
			}),
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
				const { appendDiscovery } = await import("../progress.js");

				const importance = params.importance as "fyi" | "important" | "critical";

				await appendDiscovery(coordDir, {
					id: randomUUID(),
					workerId,
					workerIdentity: identity,
					topic: params.topic,
					content: params.content,
					importance,
					timestamp: Date.now(),
				});

				await obs?.events.emit({
					type: "discovery_shared",
					discoveryId: randomUUID(),
					workerId,
					topic: params.topic,
					importance,
				});

				await storage.sendMessage({
					id: randomUUID(),
					from: identity,
					to: "all",
					type: "status",
					content: `[${importance.toUpperCase()}] ${params.topic}: ${params.content}`,
					timestamp: Date.now(),
				});

				return {
					content: [{ type: "text", text: `Discovery shared: ${params.topic}` }],
				};
			},
		},
	];

	for (const tool of tools) {
		pi.registerTool(tool);
	}
}
