import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CustomAgentTool, CustomToolFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgents } from "../../subagent/agents.js";
import { FileBasedStorage } from "../state.js";
import type { WorkerStateFile, IdentityMapping, PreAssignment } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-worker-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fsSync.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

export interface WorkerHandle {
	workerId: string;
	identity: string;
	pid: number;
	proc: ChildProcess;
	promise: Promise<number>;
}

export interface WorkerConfig {
	agent: string;
	handshakeSpec: string;
	steps: number[];
	logicalName: string;
	workerId: string;
	identity: string;
}

export function spawnWorkerProcess(
	config: WorkerConfig,
	coordDir: string,
	cwd: string,
	storage: FileBasedStorage,
	modelOverride?: string,
): WorkerHandle {
	const { agents } = discoverAgents(cwd, "user");
	const workerAgent = agents.find(a => a.name === "worker");

	const workerToolsPath = path.join(__dirname, "..", "worker-tools", "index.ts");
	const reservationHookPath = path.join(__dirname, "..", "worker-hooks", "reservation.ts");

	const { workerId, identity } = config;
	const shortId = workerId.slice(0, 4);

	const model = modelOverride || workerAgent?.model || "claude-sonnet-4-20250514";

	const args: string[] = [
		"--model", model,
		"--mode", "json",
		"-p",
		"--no-session",
		"--tool", workerToolsPath,
		"--hook", reservationHookPath,
	];

	let tmpPromptDir: string | null = null;
	if (workerAgent?.systemPrompt) {
		const tmp = writePromptToTempFile("worker", workerAgent.systemPrompt);
		tmpPromptDir = tmp.dir;
		args.push("--append-system-prompt", tmp.filePath);
	}

	args.push(`Task: ${config.handshakeSpec}`);

	const proc = spawn("pi", args, {
		cwd,
		env: {
			...process.env,
			PI_COORDINATION_DIR: coordDir,
			PI_AGENT_IDENTITY: identity,
			PI_WORKER_ID: workerId,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (!proc.pid) {
		if (tmpPromptDir) {
			try { fsSync.rmSync(tmpPromptDir, { recursive: true }); } catch {}
		}
		throw new Error(`Failed to start worker process for ${config.agent}`);
	}

	const initialState: WorkerStateFile = {
		id: workerId,
		shortId,
		identity,
		agent: config.agent,
		status: "working",
		currentFile: null,
		currentTool: null,
		waitingFor: null,
		assignedSteps: config.steps,
		completedSteps: [],
		currentStep: config.steps[0] || null,
		handshakeSpec: config.handshakeSpec,
		startedAt: Date.now(),
		completedAt: null,
		usage: { input: 0, output: 0, cost: 0, turns: 0 },
		filesModified: [],
		blockers: [],
		errorType: null,
		errorMessage: null,
	};

	try {
		fsSync.writeFileSync(
			path.join(coordDir, `worker-${workerId}.json`),
			JSON.stringify(initialState, null, 2)
		);
	} catch (err) {
		throw new Error(`Failed to create worker state file: ${err}`);
	}

	storage.appendEvent({
		type: "worker_started",
		workerId,
		timestamp: Date.now(),
	}).catch(() => {});

	proc.stdout?.on("data", () => {});

	proc.stderr?.on("data", (data) => {
		const text = data.toString().trim();
		if (text) {
			storage.appendEvent({
				type: "coordinator",
				message: `[${identity}] stderr: ${text.slice(0, 100)}`,
				timestamp: Date.now(),
			}).catch(() => {});
		}
	});

	const promise = new Promise<number>((resolve) => {
		proc.on("close", (code) => {
			if (tmpPromptDir) {
				try { fsSync.rmSync(tmpPromptDir, { recursive: true }); } catch {}
			}
			resolve(code ?? 0);
		});
		proc.on("error", () => {
			if (tmpPromptDir) {
				try { fsSync.rmSync(tmpPromptDir, { recursive: true }); } catch {}
			}
			resolve(1);
		});
	});

	return { workerId, identity, pid: proc.pid, proc, promise };
}

const WorkerSpec = Type.Object({
	agent: Type.String({ description: "Agent type name" }),
	logicalName: Type.String({ description: "Logical name like 'worker-A'" }),
	handshakeSpec: Type.String({ description: "Detailed task specification for the worker" }),
	steps: Type.Array(Type.Number(), { description: "Step numbers assigned to this worker" }),
	adjacentWorkers: Type.Optional(Type.Array(Type.String(), { description: "Logical names of workers this one interacts with" })),
	model: Type.Optional(Type.String({ description: "Model override for this worker" })),
});

const factory: CustomToolFactory = (pi) => {
	const coordDir = process.env.PI_COORDINATION_DIR;
	const identity = process.env.PI_AGENT_IDENTITY;

	if (!coordDir || !identity) {
		throw new Error("Coordinator tools require PI_COORDINATION_DIR and PI_AGENT_IDENTITY environment variables");
	}

	const storage = new FileBasedStorage(coordDir);

	const tools: CustomAgentTool[] = [
		{
			name: "spawn_workers",
			label: "Spawn Workers",
			description: "Spawn workers in parallel, wait for all to complete, and return results. This blocks until all workers finish.",
			parameters: Type.Object({
				workers: Type.Array(WorkerSpec, { description: "Worker specifications" }),
				includePlan: Type.Optional(Type.Boolean({ description: "Include full plan in worker context (default: true)" })),
			}),
			async execute(_toolCallId, params) {
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
				const identityMap: IdentityMapping[] = [];
				const handles: WorkerHandle[] = [];

				for (const w of params.workers) {
					const workerId = randomUUID();
					const shortId = workerId.slice(0, 4);
					const workerIdentity = `worker:${w.agent}-${shortId}`;
					const preAssignment = state.preAssignments?.[w.logicalName];

					identityMap.push({ logical: w.logicalName, actual: workerIdentity });
					workerPreps.push({ spec: w, workerId, shortId, identity: workerIdentity, preAssignment });

					if (preAssignment) {
						await storage.transferReservation(preAssignment.reservationId, workerIdentity);
					}
				}

				for (const prep of workerPreps) {
					const { spec: w, workerId, identity: workerIdentity, preAssignment } = prep;

					const adjacentMappings = w.adjacentWorkers?.map(ln => {
						const mapping = identityMap.find(m => m.logical === ln);
						return mapping ? `${ln} -> ${mapping.actual}` : ln;
					}).join(", ") || "none";

					const enrichedSpec = `${w.handshakeSpec}

## Your Context
- **Identity:** ${workerIdentity}
- **Logical Name:** ${w.logicalName}
- **Assigned Files:** ${preAssignment?.files.join(", ") || "none pre-assigned"}
- **Adjacent Workers:** ${adjacentMappings}

## Identity Mapping
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
						pi.cwd,
						storage,
						w.model,
					);
					handles.push(handle);
				}

				const exitCodes = await Promise.all(handles.map((h) => h.promise));

				for (let i = 0; i < handles.length; i++) {
					const exitCode = exitCodes[i];
					if (exitCode !== 0) {
						await storage.updateWorkerState(handles[i].workerId, (s) => ({
							...s,
							status: "failed",
							completedAt: Date.now(),
							errorType: "crash",
							errorMessage: `exit code ${exitCode}`,
						})).catch(() => {});

						await storage.appendEvent({
							type: "worker_failed",
							workerId: handles[i].workerId,
							error: `exit code ${exitCode}`,
							timestamp: Date.now(),
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
			async execute(_toolCallId, params) {
				const reservationId = randomUUID();
				const preAssignIdentity = `pre:${params.workerLogicalName}`;

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
					return {
						content: [{
							type: "text",
							text: `File conflict: ${params.files.join(", ")} already assigned to ${result.conflict?.agent}`,
						}],
						isError: true,
					};
				}

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
			name: "broadcast_deviation",
			label: "Broadcast Deviation",
			description: "Notify affected workers when a deviation occurs",
			parameters: Type.Object({
				deviation: Type.String({ description: "What deviated from the plan" }),
				affectedWorkers: Type.Array(Type.String(), { description: "Worker identities to notify" }),
				adaptationHint: Type.Optional(Type.String({ description: "How workers should adapt" })),
			}),
			async execute(_toolCallId, params) {
				for (const worker of params.affectedWorkers) {
					await storage.sendMessage({
						id: randomUUID(),
						from: identity,
						to: worker,
						type: "status",
						content: `DEVIATION: ${params.deviation}${params.adaptationHint ? `\n\nAdaptation: ${params.adaptationHint}` : ""}`,
						timestamp: Date.now(),
					});
				}

				await storage.appendDeviation({
					type: "plan_deviation",
					description: params.deviation,
					timestamp: Date.now(),
				});

				return {
					content: [{ type: "text", text: `Notified ${params.affectedWorkers.length} workers of deviation` }],
				};
			},
		},

		{
			name: "check_status",
			label: "Check Status",
			description: "Get current status of all workers, contracts, and reservations",
			parameters: Type.Object({}),
			async execute() {
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
			async execute(_toolCallId, params) {
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
			async execute(_toolCallId, params) {
				await storage.updateContract(params.item, () => ({
					id: randomUUID(),
					item: params.item,
					type: params.type as "type" | "function" | "file",
					provider: params.provider,
					status: "pending",
					waiters: params.waiters,
					expectedSignature: params.signature,
				}));

				await storage.appendEvent({
					type: "coordinator",
					message: `Contract created: ${params.item}`,
					timestamp: Date.now(),
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
			async execute(_toolCallId, params) {
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
			async execute(_toolCallId, params) {
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
};

export default factory;
