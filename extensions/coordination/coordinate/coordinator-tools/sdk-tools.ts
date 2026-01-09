/**
 * SDK-compatible coordinator tools.
 *
 * These tools are designed to be passed to createAgentSession({ customTools: ... })
 * instead of being registered via ExtensionAPI.
 *
 * Key differences from extension-based tools:
 * - Takes coordDir and identity as parameters (not from env vars)
 * - Returns ToolDefinition[] directly
 * - Works with in-process SDK execution
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "../../subagent/agents.js";
import { FileBasedStorage } from "../state.js";
import type { PreAssignment } from "../types.js";
import { createWorkerObservability, type ObservabilityContext } from "../observability/index.js";
import { spawnWorkerProcess, type WorkerHandle } from "./index.js";

interface RuntimeConfig {
	selfReview?: { enabled?: boolean; maxCycles?: number };
	supervisor?: { enabled?: boolean; nudgeThresholdMs?: number; restartThresholdMs?: number; maxRestarts?: number; checkIntervalMs?: number; dynamicSpawnTimeoutMs?: number };
	models?: { scout?: string; planner?: string; coordinator?: string; worker?: string; reviewer?: string };
}

function loadRuntimeConfig(coordDir: string): RuntimeConfig {
	try {
		const content = fsSync.readFileSync(path.join(coordDir, "runtime-config.json"), "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const WorkerSpec = Type.Object({
	agent: Type.String({ description: "Agent type name" }),
	logicalName: Type.String({ description: "Logical name like 'worker-A'" }),
	handshakeSpec: Type.String({ description: "Detailed task specification for the worker" }),
	steps: Type.Array(Type.Number(), { description: "Step numbers assigned to this worker" }),
	adjacentWorkers: Type.Optional(Type.Array(Type.String(), { description: "Logical names of workers this one interacts with" })),
	model: Type.Optional(Type.String({ description: "Model override for this worker" })),
});

export interface SDKCoordinatorToolsConfig {
	/** Coordination directory for state storage */
	coordDir: string;
	/** Identity of the coordinator */
	identity: string;
	/** Working directory */
	cwd: string;
	/** Trace ID for distributed tracing */
	traceId?: string;
}

/**
 * Get coordinator tools for use with the Pi SDK.
 *
 * Usage:
 * ```typescript
 * const { session } = await createAgentSession({
 *   customTools: getCoordinatorToolsForSDK({
 *     coordDir: "/path/to/coord",
 *     identity: "coordinator",
 *     cwd: process.cwd(),
 *   }),
 * });
 * ```
 */
export function getCoordinatorToolsForSDK(config: SDKCoordinatorToolsConfig): ToolDefinition[] {
	const { coordDir, identity, cwd, traceId } = config;

	const storage = new FileBasedStorage(coordDir);
	let obs: ObservabilityContext | null = null;

	const getObs = () => {
		if (!obs) {
			obs = createWorkerObservability(coordDir, traceId, identity, cwd, "coordinator");
		}
		return obs;
	};

	const tools: ToolDefinition[] = [
		{
			name: "spawn_workers",
			label: "Spawn Workers",
			description: "Spawn workers in parallel, wait for all to complete, and return results. This blocks until all workers finish.",
			parameters: Type.Object({
				workers: Type.Array(WorkerSpec, { description: "Worker specifications" }),
				includePlan: Type.Optional(Type.Boolean({ description: "Include full plan in worker context (default: true)" })),
			}),
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs();
				const state = await storage.getState();
				let planContent = "";
				if (params.includePlan !== false) {
					try {
						planContent = await fs.readFile(state.planPath, "utf-8");
					} catch {}
				}

				interface WorkerPrep {
					spec: typeof params.workers[0];
					workerId: string;
					shortId: string;
					identity: string;
					preAssignment?: PreAssignment;
				}

				const workerPreps: WorkerPrep[] = [];
				const identityMap: Array<{ logical: string; actual: string }> = [];
				const handles: WorkerHandle[] = [];

				for (const w of params.workers) {
					const workerId = randomUUID();
					const shortId = workerId.slice(0, 4);
					const workerIdentity = `worker:${w.agent}-${shortId}`;
					const preAssignment = state.preAssignments?.[w.logicalName];

					identityMap.push({ logical: w.logicalName, actual: workerIdentity });
					workerPreps.push({ spec: w, workerId, shortId, identity: workerIdentity, preAssignment });

					if (preAssignment) {
						const preAssignIdentity = `pre:${w.logicalName}`;
						await storage.transferReservation(preAssignment.reservationId, workerIdentity);
						await obs?.events.emit({
							type: "reservation_transferred",
							reservationId: preAssignment.reservationId,
							from: preAssignIdentity,
							to: workerIdentity,
						});
					}
				}

				for (const prep of workerPreps) {
					const { spec: w, workerId, identity: workerIdentity, preAssignment } = prep;

					const adjacentMappings = w.adjacentWorkers?.map(ln => {
						const mapping = identityMap.find(m => m.logical === ln);
						return mapping ? `${ln} -> ${mapping.actual}` : ln;
					}).join(", ") || "none";

					const sharedContextPath = process.env.PI_COORDINATION_SHARED_CONTEXT;
					const sharedContextSection = sharedContextPath && fsSync.existsSync(sharedContextPath)
						? `## Shared Context\nRead: ${sharedContextPath}\n\n`
						: "";

					const outputsDir = path.join(coordDir, "outputs");
					try { fsSync.mkdirSync(outputsDir, { recursive: true }); } catch {}
					const outputPath = path.join(outputsDir, `${workerId}.md`);
					const outputSection = `## Output\nWrite primary results to: ${outputPath}\n\n`;

					const enrichedSpec = `${w.handshakeSpec}

## Your Context
- **Identity:** ${workerIdentity}
- **Logical Name:** ${w.logicalName}
- **Assigned Files:** ${preAssignment?.files.join(", ") || "none pre-assigned"}
- **Adjacent Workers:** ${adjacentMappings}

${sharedContextSection}${outputSection}## Identity Mapping
${identityMap.map(m => `- ${m.logical} = ${m.actual}`).join("\n")}

${planContent ? `## Full Plan\n\`\`\`markdown\n${planContent}\n\`\`\`` : ""}
`;

					const handle = spawnWorkerProcess(
						{
							agent: w.agent,
							handshakeSpec: enrichedSpec,
							steps: w.steps,
							logicalName: w.logicalName,
							workerId,
							identity: workerIdentity,
						},
						coordDir,
						ctx?.cwd ?? cwd,
						storage,
						w.model,
						obs || undefined,
					);
					handles.push(handle);
				}

				const exitCodes = await Promise.all(handles.map((h) => h.promise));

				for (let i = 0; i < handles.length; i++) {
					const exitCode = exitCodes[i];
					const handle = handles[i];
					const workerState = await storage.readWorkerState(handle.workerId).catch(() => null);

					if (exitCode !== 0) {
						await storage.updateWorkerState(handle.workerId, (s) => ({
							...s,
							status: "failed",
							completedAt: Date.now(),
							errorType: "crash",
							errorMessage: `exit code ${exitCode}`,
						})).catch(() => {});

						await storage.appendEvent({
							type: "worker_failed",
							workerId: handle.workerId,
							error: `exit code ${exitCode}`,
							timestamp: Date.now(),
						});
					} else {
						await obs?.events.emit({
							type: "worker_completed",
							workerId: handle.workerId,
							result: {
								filesModified: workerState?.filesModified || [],
								stepsCompleted: workerState?.completedSteps || [],
								cost: workerState?.usage.cost || 0,
								turns: workerState?.usage.turns || 0,
							},
						});
					}
				}

				const workerStates = await storage.listWorkerStates();
				const workerResults = handles.map((h, i) => {
					const w = workerStates.find(ws => ws.id === h.workerId);
					return `- ${h.identity}: ${w?.status || "unknown"} (exit ${exitCodes[i]})`;
				});

				return {
					content: [{ type: "text", text: `All ${handles.length} workers completed:\n${workerResults.join("\n")}` }],
					details: { workers: handles.map((h) => ({ workerId: h.workerId, identity: h.identity, pid: h.pid })) },
				};
			},
		},

		{
			name: "assign_files",
			label: "Assign Files",
			description: "Pre-assign files to a worker before spawning. Creates actual file reservations. First assignment wins.",
			parameters: Type.Object({
				workerLogicalName: Type.String({ description: "Logical worker name (e.g., 'worker-A')" }),
				files: Type.Array(Type.String(), { description: "Files this worker will own" }),
			}),
			async execute(_toolCallId, params, _onUpdate, _ctx) {
				const obs = getObs();
				const reservationId = randomUUID();
				const preAssignIdentity = `pre:${params.workerLogicalName}`;

				await obs?.events.emit({
					type: "reservation_requested",
					reservationId,
					patterns: params.files,
					exclusive: true,
				});

				const result = await storage.reserveFiles({
					id: reservationId,
					agent: preAssignIdentity,
					patterns: params.files,
					exclusive: true,
					reason: `Pre-assigned to ${params.workerLogicalName}`,
					createdAt: Date.now(),
					expiresAt: Date.now() + 3600000,
				});

				if (!result.success) {
					await obs?.events.emit({
						type: "reservation_denied",
						reservationId,
						conflict: {
							agent: result.conflict?.agent || "unknown",
							patterns: result.conflict?.patterns || [],
						},
					});

					return {
						content: [{
							type: "text",
							text: `File conflict: ${params.files.join(", ")} already assigned to ${result.conflict?.agent}`,
						}],
						isError: true,
					};
				}

				await obs?.events.emit({
					type: "reservation_granted",
					reservationId,
				});

				const state = await storage.getState();
				await storage.setState({
					...state,
					preAssignments: {
						...state.preAssignments,
						[params.workerLogicalName]: {
							files: params.files,
							reservationId,
						},
					},
				});

				return {
					content: [{ type: "text", text: `Assigned ${params.files.join(", ")} to ${params.workerLogicalName}` }],
				};
			},
		},

		{
			name: "check_status",
			label: "Check Status",
			description: "Get current status of all workers, contracts, and reservations",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _onUpdate, _ctx) {
				const state = await storage.getState();
				const workerStates = await storage.listWorkerStates();
				const messages = await storage.getMessages({ since: Date.now() - 60000 });
				const reservations = await storage.getActiveReservations();

				const workerSummaries = workerStates.map(w => ({
					identity: w.identity,
					status: w.status,
					currentStep: w.currentStep,
					completedSteps: w.completedSteps,
					blockers: w.blockers,
					waitingFor: w.waitingFor,
				}));

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									coordinationStatus: state.status,
									workers: workerSummaries,
									contracts: state.contracts,
									activeReservations: reservations.length,
									recentMessages: messages.length,
								},
								null,
								2,
							),
						},
					],
					details: { workerStates, contracts: state.contracts, reservations, messages },
				};
			},
		},

		{
			name: "broadcast",
			label: "Broadcast",
			description: "Send a message to all workers",
			parameters: Type.Object({
				message: Type.String({ description: "Message content" }),
			}),
			async execute(_toolCallId, params, _onUpdate, _ctx) {
				await storage.sendMessage({
					id: randomUUID(),
					from: identity,
					to: "all",
					type: "status",
					content: params.message,
					timestamp: Date.now(),
				});

				await storage.appendEvent({
					type: "coordinator",
					message: `Broadcast: ${params.message}`,
					timestamp: Date.now(),
				});

				const workerStates = await storage.listWorkerStates();
				return {
					content: [{ type: "text", text: `Broadcast sent to ${workerStates.length} workers` }],
				};
			},
		},

		{
			name: "escalate_to_user",
			label: "Escalate to User",
			description: "Ask the user a question with timed auto-decision",
			parameters: Type.Object({
				question: Type.String({ description: "Question to ask" }),
				options: Type.Array(Type.String(), { description: "Available options" }),
				timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 60)" })),
				defaultOption: Type.Optional(Type.Number({ description: "Index of default option (0-based)" })),
			}),
			async execute(_toolCallId, params, _onUpdate, _ctx) {
				const obs = getObs();
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
			name: "create_contract",
			label: "Create Contract",
			description: "Define a contract/interface between workers",
			parameters: Type.Object({
				item: Type.String({ description: "Contract item name (e.g., 'AuthUser type')" }),
				type: Type.String({ description: "Contract type: 'type', 'function', or 'file'" }),
				provider: Type.String({ description: "Worker identity that will provide this" }),
				waiters: Type.Array(Type.String(), { description: "Worker identities waiting for this" }),
				signature: Type.Optional(Type.String({ description: "Expected signature" })),
			}),
			async execute(_toolCallId, params, _onUpdate, _ctx) {
				const obs = getObs();
				const contractId = randomUUID();
				const contract = {
					id: contractId,
					item: params.item,
					type: params.type as "type" | "function" | "file",
					provider: params.provider,
					status: "pending" as const,
					waiters: params.waiters,
					expectedSignature: params.signature,
				};

				await storage.updateContract(params.item, () => contract);

				await storage.appendEvent({
					type: "coordinator",
					message: `Contract created: ${params.item}`,
					timestamp: Date.now(),
				});

				await obs?.events.emit({
					type: "contract_created",
					contract,
					creator: identity,
				});

				return {
					content: [{ type: "text", text: `Contract created: ${params.item}` }],
				};
			},
		},

		{
			name: "update_progress",
			label: "Update Progress",
			description: "Update the PROGRESS.md file in the coordination directory",
			parameters: Type.Object({
				content: Type.String({ description: "Markdown content for PROGRESS.md" }),
			}),
			async execute(_toolCallId, params, _onUpdate, _ctx) {
				await storage.updateProgress(params.content);
				return {
					content: [{ type: "text", text: "PROGRESS.md updated" }],
				};
			},
		},

		{
			name: "done",
			label: "Done",
			description: "Signal that coordination is complete. VALIDATION: Fails if no workers were spawned or if any workers are not complete.",
			parameters: Type.Object({
				summary: Type.String({ description: "Summary of what was accomplished" }),
				filesModified: Type.Optional(Type.Array(Type.String(), { description: "List of modified files" })),
				deviations: Type.Optional(Type.Array(Type.String(), { description: "Any deviations from original plan" })),
			}),
			async execute(_toolCallId, params, _onUpdate, _ctx) {
				const state = await storage.getState();
				const workerStates = await storage.listWorkerStates();

				if (workerStates.length === 0) {
					return {
						content: [{
							type: "text",
							text: "ERROR: Cannot complete - no workers have been spawned. You MUST call spawn_workers() first to create workers that will execute the plan.",
						}],
						isError: true,
					};
				}

				const incompleteWorkers = workerStates.filter((w) => w.status !== "complete");
				if (incompleteWorkers.length > 0) {
					const workerStatus = workerStates.map((w) => `- ${w.identity}: ${w.status}`).join("\n");
					return {
						content: [{
							type: "text",
							text: `ERROR: Cannot complete - ${incompleteWorkers.length} worker(s) not finished.\n\nWorker status:\n${workerStatus}\n\nCall check_status() to monitor progress and wait for all workers to complete.`,
						}],
						isError: true,
					};
				}

				await storage.sendMessage({
					id: randomUUID(),
					from: identity,
					to: "all",
					type: "status",
					content: "COORDINATION_COMPLETE",
					timestamp: Date.now(),
				});

				const deviations = params.deviations?.map((d) => ({ type: "deviation", description: d, timestamp: Date.now() })) || [];
				const existingDeviations = state.deviations || [];

				await storage.updateState({
					status: "complete",
					completedAt: Date.now(),
					deviations: [...existingDeviations, ...deviations],
				});

				await storage.appendEvent({
					type: "coordinator",
					message: `Coordination complete: ${params.summary}`,
					timestamp: Date.now(),
				});

				return {
					content: [{ type: "text", text: params.summary }],
					details: { summary: params.summary, filesModified: params.filesModified, deviations: params.deviations },
				};
			},
		},
	];

	return tools;
}
