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
							cacheRead: (state.usage.cacheRead || 0) + (usage.cacheRead || 0),
							cacheWrite: (state.usage.cacheWrite || 0) + (usage.cacheWrite || 0),
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

// Fresh eyes review prompt for workers
const FRESH_EYES_PROMPT = `Before completing, do a fresh eyes review:

1. **Read each file you modified** using the read tool
2. **Review your changes** looking for:
   - Obvious bugs or logic errors
   - Missing error handling
   - Typos or syntax issues
   - Incomplete implementations
   - Inconsistencies with existing code patterns

3. **If you find issues**: Fix them now, then try completing again
4. **If no issues found**: Call agent_work({ action: 'complete' }) again with your result

Take your time - this self-review catches many bugs before the formal review phase.`;

// Max fresh eyes cycles to prevent infinite loops (default: 2)
const MAX_FRESH_EYES_CYCLES = parseInt(process.env.PI_FRESH_EYES_MAX_CYCLES || "2", 10);

/** Optional context for SDK workers (avoids env var race conditions) */
export interface WorkerToolsContext {
	coordDir: string;
	workerId: string;
	identity: string;
}

export function registerWorkerTools(pi: ExtensionAPI, ctx?: WorkerToolsContext): void {
	// Use provided context or fall back to env vars (for subprocess workers)
	const coordDir = ctx?.coordDir ?? process.env.PI_COORDINATION_DIR;
	const identity = ctx?.identity ?? process.env.PI_AGENT_IDENTITY;
	const workerId = ctx?.workerId ?? process.env.PI_WORKER_ID;
	const freshEyesEnabled = process.env.PI_FRESH_EYES_ENABLED !== "false"; // Enabled by default

	if (!coordDir || !identity || !workerId) {
		throw new Error("Worker tools require context or PI_COORDINATION_DIR, PI_AGENT_IDENTITY, and PI_WORKER_ID environment variables");
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
	let freshEyesCycleCount = 0; // Track fresh eyes review cycles

	registerWorkerEventHandlers(pi, storage, identity, workerId);

	const tools: ToolDefinition<any, any>[] = [
		{
			name: "agent_chat",
			label: "Agent Chat",
			description: "All communication - with other agents, coordinator, or user. Use action='inbox' to check messages.",
			parameters: Type.Object({
				action: Type.Optional(Type.String({ description: "Action: 'send' (default) or 'inbox'" })),
				to: Type.Optional(Type.String({ description: "Recipient: worker identity, 'coordinator', 'all', or 'user'" })),
				content: Type.Optional(Type.String({ description: "Message content" })),
				type: Type.Optional(Type.String({ description: "Message type: 'handover', 'clarification', 'response', 'status', 'conflict'" })),
				topic: Type.Optional(Type.String({ description: "Topic for broadcast (to: 'all')" })),
				importance: Type.Optional(Type.String({ description: "Importance: 'fyi', 'important', 'critical' (to: 'all')" })),
				question: Type.Optional(Type.String({ description: "Question for user (to: 'user')" })),
				options: Type.Optional(Type.Array(Type.String(), { description: "Options for user escalation" })),
				timeout: Type.Optional(Type.Number({ description: "Timeout seconds (default: 60)" })),
				defaultOption: Type.Optional(Type.Number({ description: "Default option index if timeout" })),
				since: Type.Optional(Type.Number({ description: "Only messages since timestamp (action: 'inbox')" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const obs = getObs(ctx);

				// Inbox action
				if (params.action === "inbox") {
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
				}

				// Send action (default)
				if (!params.to) {
					return {
						content: [{ type: "text", text: "Error: 'to' is required for sending messages" }],
						isError: true,
					};
				}

				// Escalate to user
				if (params.to === "user") {
					if (!params.question || !params.options) {
						return {
							content: [{ type: "text", text: "Error: 'question' and 'options' required for user escalation" }],
							isError: true,
						};
					}

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
				}

				// Broadcast to all (also persists to discoveries.json)
				if (params.to === "all") {
					if (!params.topic || !params.content) {
						return {
							content: [{ type: "text", text: "Error: 'topic' and 'content' required for broadcast" }],
							isError: true,
						};
					}

					const { appendDiscovery } = await import("../progress.js");
					const importance = (params.importance || "fyi") as "fyi" | "important" | "critical";
					const discoveryId = randomUUID();

					await appendDiscovery(coordDir, {
						id: discoveryId,
						workerId,
						workerIdentity: identity,
						topic: params.topic,
						content: params.content,
						importance,
						timestamp: Date.now(),
					});

					await obs?.events.emit({
						type: "discovery_shared",
						discoveryId,
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
				}

				// Regular message to worker or coordinator
				if (!params.content) {
					return {
						content: [{ type: "text", text: "Error: 'content' required for messages" }],
						isError: true,
					};
				}

				const msgId = randomUUID();
				const msgType = (params.type || "status") as "handover" | "clarification" | "response" | "status" | "conflict";

				await storage.sendMessage({
					id: msgId,
					from: identity,
					to: params.to,
					type: msgType,
					content: params.content,
					timestamp: Date.now(),
				});

				// Route worker→coordinator and worker→worker messages through the mesh log
				await storage.appendMeshMessage({
					id: msgId,
					from: workerId,
					to: params.to,
					message: params.content,
					timestamp: Date.now(),
					taskId: process.env.PI_TASK_ID,
					type: (msgType === "handover" ? "handoff" :
					       msgType === "status" ? "coordination" :
					       "coordination") as "coordination" | "handoff" | "deviation" | "question",
				}).catch((err: unknown) => { console.warn("[worker-tools] appendMeshMessage failed:", err instanceof Error ? err.message : err); });

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
			name: "agent_sync",
			label: "Agent Sync",
			description: "Interface synchronization between workers. Use action='provide' to signal an interface is ready, action='need' to wait for one.",
			parameters: Type.Object({
				action: Type.String({ description: "Action: 'provide' or 'need'" }),
				item: Type.String({ description: "Interface/contract name" }),
				signature: Type.Optional(Type.String({ description: "Actual signature/definition (for provide)" })),
				file: Type.Optional(Type.String({ description: "File where defined (for provide)" })),
				timeout: Type.Optional(Type.Number({ description: "Timeout seconds (default: 300, for need)" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const obs = getObs(ctx);

				if (params.action === "provide") {
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
				}

				if (params.action === "need") {
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

					// Fast path: if contract is already ready, return immediately
					if (contract.status === "ready") {
						return {
							content: [{ type: "text", text: `Contract ready: ${params.item}` }],
							details: { contract },
						};
					}

					// Register as waiter so provider can notify us directly
					await storage.updateContract(params.item, (c) => {
						if (!c) return undefined;
						const waiters = c.waiters.includes(identity) ? c.waiters : [...c.waiters, identity];
						return { ...c, waiters };
					});

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
				}

				return {
					content: [{ type: "text", text: "Error: action must be 'provide' or 'need'" }],
					isError: true,
				};
			},
		},

		{
			name: "agent_work",
			label: "Agent Work",
			description: "Task lifecycle management - completing work, updating progress, discovering new work, reporting deviations, reading plan.",
			parameters: Type.Object({
				action: Type.String({ description: "Action: 'complete', 'step', 'add', 'deviation', or 'plan'" }),
				result: Type.Optional(Type.String({ description: "Summary of accomplishment (for complete)" })),
				filesModified: Type.Optional(Type.Array(Type.String(), { description: "Files modified (for complete)" })),
				step: Type.Optional(Type.Number({ description: "Step number (for step)" })),
				status: Type.Optional(Type.String({ description: "Status message (for step)" })),
				description: Type.Optional(Type.String({ description: "What needs to be done (for add/deviation)" })),
				files: Type.Optional(Type.Array(Type.String(), { description: "Files to modify (for add)" })),
				creates: Type.Optional(Type.Array(Type.String(), { description: "Files to create (for add)" })),
				dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this depends on (for add)" })),
				priority: Type.Optional(Type.Number({ description: "0=critical, 1=high, 2=medium, 3=low (for add)" })),
				reason: Type.Optional(Type.String({ description: "Why this task is needed (for add/deviation)" })),
				affectsOthers: Type.Optional(Type.Boolean({ description: "Could this affect other workers? (for deviation)" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const obs = getObs(ctx);

				// Complete task
				if (params.action === "complete") {
					// Fresh eyes review gate - require self-review before completing
					if (freshEyesEnabled && freshEyesCycleCount < MAX_FRESH_EYES_CYCLES) {
						freshEyesCycleCount++;
						
						if (freshEyesCycleCount === 1) {
							// First completion attempt - trigger fresh eyes review
							return {
								content: [{ type: "text", text: FRESH_EYES_PROMPT }],
								details: { freshEyesReview: true, cycle: freshEyesCycleCount },
							};
						}
						// Subsequent attempts allowed through (they've done at least one review)
					}

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
						content: `Completed: ${params.result || "Task finished"}`,
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
				}

				// Update step
				if (params.action === "step") {
					if (params.step === undefined) {
						return {
							content: [{ type: "text", text: "Error: 'step' required for step action" }],
							isError: true,
						};
					}

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
				}

				// Add discovered task
				if (params.action === "add") {
					if (!params.description) {
						return {
							content: [{ type: "text", text: "Error: 'description' required for add action" }],
							isError: true,
						};
					}

					const { TaskQueueManager } = await import("../task-queue.js");
					const taskQueue = new TaskQueueManager(coordDir);

					// ID auto-generated atomically inside addDiscoveredTask
					const task = await taskQueue.addDiscoveredTask({
						description: params.description,
						priority: params.priority ?? 2,
						files: params.files,
						creates: params.creates,
						dependsOn: params.dependsOn,
						discoveredFrom: workerId,
						acceptanceCriteria: params.reason ? [`Discovered: ${params.reason}`] : [],
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
						content: `Discovered new task: ${task.id} - ${params.description}${params.reason ? `\nReason: ${params.reason}` : ""}`,
						timestamp: Date.now(),
					});

					return {
						content: [{ type: "text", text: `Task ${task.id} added for planner review` }],
						details: { task },
					};
				}

				// Report deviation
				if (params.action === "deviation") {
					if (!params.description) {
						return {
							content: [{ type: "text", text: "Error: 'description' required for deviation action" }],
							isError: true,
						};
					}

					const deviationObj = {
						description: params.description,
						reason: params.reason || "",
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
						affectsOthers: params.affectsOthers || false,
					});

					if (params.affectsOthers) {
						await storage.sendMessage({
							id: randomUUID(),
							from: identity,
							to: "coordinator",
							type: "status",
							content: `DEVIATION (affects others): ${params.description}\nReason: ${params.reason || "Not specified"}`,
							timestamp: Date.now(),
						});
					}

					return {
						content: [{ type: "text", text: "Deviation recorded" }],
					};
				}

				// Read plan
				if (params.action === "plan") {
					const state = await storage.getState();
					const content = await fs.readFile(state.planPath, "utf-8");
					return {
						content: [{ type: "text", text: content }],
					};
				}

				return {
					content: [{ type: "text", text: "Error: action must be 'complete', 'step', 'add', 'deviation', or 'plan'" }],
					isError: true,
				};
			},
		},

		{
			name: "file_reservations",
			label: "File Reservations",
			description: "Shared file resource management - prevent conflicts between parallel workers.",
			parameters: Type.Object({
				action: Type.String({ description: "Action: 'acquire', 'release', or 'check'" }),
				patterns: Type.Optional(Type.Array(Type.String(), { description: "File patterns (e.g., 'src/auth/**', 'src/types.ts')" })),
				exclusive: Type.Optional(Type.Boolean({ description: "Block other workers from these files (default: true)" })),
				ttl: Type.Optional(Type.Number({ description: "Reservation time-to-live in seconds (default: 300)" })),
				reason: Type.Optional(Type.String({ description: "Why you need these files" })),
				path: Type.Optional(Type.String({ description: "Specific file path to check" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const obs = getObs(ctx);

				// Acquire reservation
				if (params.action === "acquire") {
					if (!params.patterns || params.patterns.length === 0) {
						return {
							content: [{ type: "text", text: "Error: 'patterns' required for acquire action" }],
							isError: true,
						};
					}

					const reservationId = randomUUID();
					const exclusive = params.exclusive !== false;
					const ttl = params.ttl || 300;

					await obs?.events.emit({
						type: "reservation_requested",
						reservationId,
						patterns: params.patterns,
						exclusive,
					});

					const result = await storage.reserveFiles({
						id: reservationId,
						agent: identity,
						patterns: params.patterns,
						exclusive,
						reason: params.reason || "No reason provided",
						createdAt: Date.now(),
						expiresAt: Date.now() + ttl * 1000,
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
				}

				// Release reservation
				if (params.action === "release") {
					if (!params.patterns || params.patterns.length === 0) {
						return {
							content: [{ type: "text", text: "Error: 'patterns' required for release action" }],
							isError: true,
						};
					}

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
				}

				// Check reservation
				if (params.action === "check") {
					if (!params.path) {
						return {
							content: [{ type: "text", text: "Error: 'path' required for check action" }],
							isError: true,
						};
					}

					const reservation = await storage.checkReservation(params.path);
					if (!reservation) {
						return {
							content: [{ type: "text", text: `File not reserved: ${params.path}` }],
							details: { reserved: false },
						};
					}

					const expiresIn = Math.max(0, Math.floor((reservation.expiresAt - Date.now()) / 1000));
					return {
						content: [{
							type: "text",
							text: `File reserved by ${reservation.agent}:\n` +
								`Reason: ${reservation.reason}\n` +
								`Exclusive: ${reservation.exclusive}\n` +
								`Expires in: ${expiresIn}s`,
						}],
						details: { reserved: true, reservation },
					};
				}

				return {
					content: [{ type: "text", text: "Error: action must be 'acquire', 'release', or 'check'" }],
					isError: true,
				};
			},
		},
	];

	// Register all tools
	for (const tool of tools) {
		pi.registerTool(tool);
	}
}
