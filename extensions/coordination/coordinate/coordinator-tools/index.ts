import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionContext, ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgents } from "../../subagent/agents.js";
import { FileBasedStorage } from "../state.js";
import type { WorkerStateFile, IdentityMapping, PreAssignment } from "../types.js";
import { createWorkerObservability, type ObservabilityContext } from "../observability/index.js";
import { createArtifactPaths } from "../../subagent/artifacts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface RuntimeConfig {
	selfReview?: { enabled?: boolean; maxCycles?: number };
	supervisor?: { enabled?: boolean; nudgeThresholdMs?: number; restartThresholdMs?: number; maxRestarts?: number; checkIntervalMs?: number };
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

const WORKER_UPDATE_THROTTLE_MS = 250;
const WORKER_RECENT_TOOLS_LIMIT = 5;

function extractToolArgsPreview(args: Record<string, unknown>): string | null {
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];
	for (const key of previewKeys) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			return value.length > 60 ? `${value.slice(0, 57)}...` : value;
		}
	}
	return null;
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
	taskId?: string;
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
	obs?: ObservabilityContext,
	agentName?: string,
): WorkerHandle {
	const { agents } = discoverAgents(cwd, "user");
	const targetAgent = agentName || "coordination/worker";
	const workerAgent = agents.find(a => a.name === targetAgent) || agents.find(a => a.name === "worker");

	const workerExtensionPath = path.join(__dirname, "..", "..", "..", "extensions", "coordination", "worker.ts");

	const { workerId, identity } = config;
	const shortId = workerId.slice(0, 4);

	const runtimeConfigForModel = loadRuntimeConfig(coordDir);
	const model = modelOverride || runtimeConfigForModel.models?.worker || workerAgent?.model;

	const args: string[] = [
		"--mode", "json",
		"-p",
		"--no-session",
		"--extension", workerExtensionPath,
	];
	if (model) {
		args.unshift("--model", model);
	}

	let tmpPromptDir: string | null = null;
	if (workerAgent?.systemPrompt) {
		const tmp = writePromptToTempFile("worker", workerAgent.systemPrompt);
		tmpPromptDir = tmp.dir;
		args.push("--append-system-prompt", tmp.filePath);
	}

	args.push(`Task: ${config.handshakeSpec}`);

	const runId = randomUUID();
	const artifactPaths = createArtifactPaths(identity, runId, path.join(coordDir, "artifacts"));
	try {
		const inputContent = workerAgent?.systemPrompt?.trim()
			? `# System Prompt\n\n${workerAgent.systemPrompt.trim()}\n\n# Task\n\n${config.handshakeSpec}`
			: config.handshakeSpec;
		fsSync.writeFileSync(artifactPaths.inputPath, inputContent, { encoding: "utf-8", mode: 0o600 });
	} catch {}
	const jsonlStream = fsSync.createWriteStream(artifactPaths.jsonlPath, { flags: "a" });

	obs?.events.emit({
		type: "worker_spawning",
		workerId,
		config: {
			agent: config.agent,
			logicalName: config.logicalName,
			steps: config.steps,
			handshakeSpec: config.handshakeSpec.slice(0, 200),
		},
	}).catch(() => {});

	const traceId = obs?.getTraceId() || process.env.PI_TRACE_ID;
	const runtimeConfig = loadRuntimeConfig(coordDir);

	const proc = spawn("pi", args, {
		cwd,
		env: {
			...process.env,
			PI_COORDINATION_DIR: coordDir,
			PI_AGENT_IDENTITY: identity,
			PI_WORKER_ID: workerId,
			...(traceId ? { PI_TRACE_ID: traceId } : {}),
			...(runtimeConfig.selfReview?.enabled !== undefined ? { PI_SELF_REVIEW_ENABLED: String(runtimeConfig.selfReview.enabled) } : {}),
			...(runtimeConfig.selfReview?.maxCycles !== undefined ? { PI_MAX_SELF_REVIEW_CYCLES: String(runtimeConfig.selfReview.maxCycles) } : {}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (!proc.pid) {
		try { jsonlStream.end(); } catch {}
		if (tmpPromptDir) {
			try { fsSync.rmSync(tmpPromptDir, { recursive: true }); } catch {}
		}
		throw new Error(`Failed to start worker process for ${config.agent}`);
	}

	obs?.events.emit({
		type: "worker_started",
		workerId,
		pid: proc.pid,
	}).catch(() => {});

	obs?.resources.trackCreation("process", workerId, identity, {
		pid: proc.pid,
		agent: config.agent,
	}, 600000).catch(() => {});

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
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		recentTools: [],
		lastOutput: "",
		artifactsDir: artifactPaths.dir,
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

	const startTime = Date.now();
	let lastUpdateMs = 0;
	let toolCount = 0;
	let tokens = 0;
	let tokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let currentTool: string | null = null;
	let currentToolArgs: string | null = null;
	let currentFile: string | null = null;
	let recentTools: Array<{ tool: string; args: string; endMs: number }> = [];
	let lastOutput = "";
	let rawOutput = "";
	let stdoutBuffer = "";

	const extractFileFromArgs = (toolName: string, args: any): string | null => {
		if (!args) return null;
		if (args.path) return args.path;
		if (args.file) return args.file;
		if (toolName === "bash" && args.command) {
			const match = args.command.match(/(?:cat|less|head|tail|vim|nano|code)\s+["']?([^\s"']+)/);
			if (match) return match[1];
		}
		return null;
	};

	const updateWorkerProgress = (force = false) => {
		const now = Date.now();
		if (!force && now - lastUpdateMs < WORKER_UPDATE_THROTTLE_MS) return;
		lastUpdateMs = now;
		storage.updateWorkerState(workerId, (s) => ({
			...s,
			currentTool,
			currentFile,
			toolCount,
			tokens,
			durationMs: now - startTime,
			recentTools,
			lastOutput,
		})).catch(() => {});
	};

	const handleJsonLine = (line: string) => {
		if (!line.trim()) return;
		try {
			jsonlStream.write(line + "\n");
		} catch {}
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (event.type === "tool_execution_start") {
			toolCount += 1;
			currentTool = event.toolName || null;
			currentToolArgs = extractToolArgsPreview(event.toolArgs || event.args || {}) || null;
			const toolArgs = event.toolArgs || event.args || {};
			currentFile = extractFileFromArgs(event.toolName || "", toolArgs);
			updateWorkerProgress();
		}

		if (event.type === "tool_execution_end") {
			if (currentTool) {
				recentTools.unshift({
					tool: currentTool,
					args: currentToolArgs || "",
					endMs: Date.now(),
				});
				if (recentTools.length > WORKER_RECENT_TOOLS_LIMIT) {
					recentTools = recentTools.slice(0, WORKER_RECENT_TOOLS_LIMIT);
				}
			}
			currentTool = null;
			currentToolArgs = null;
			currentFile = null;
			updateWorkerProgress();
		}

		if (event.type === "message_update") {
			const updateContent = event.message?.content || event.content || event.result?.content;
			if (Array.isArray(updateContent)) {
				const lines: string[] = [];
				for (const block of updateContent) {
					if (block.type === "text" && block.text) {
						lines.push(...block.text.split("\n").filter((l: string) => l.trim()));
					}
				}
				if (lines.length) {
					lastOutput = lines.slice(-8).join("\n");
					updateWorkerProgress();
				}
			}
		}

		if (event.type === "message_end" && event.message) {
			const msg = event.message;
			if (msg.role === "assistant") {
				const usage = msg.usage;
				if (usage) {
					tokenTotals.input += usage.input || 0;
					tokenTotals.output += usage.output || 0;
					tokenTotals.cacheRead += usage.cacheRead || 0;
					tokenTotals.cacheWrite += usage.cacheWrite || 0;
					tokens = tokenTotals.input + tokenTotals.output + tokenTotals.cacheRead + tokenTotals.cacheWrite;
				}
				for (const block of msg.content || []) {
					if (block.type === "text" && block.text) rawOutput += block.text;
				}
			}
			updateWorkerProgress(true);
		}
	};

	proc.stdout?.on("data", (data) => {
		stdoutBuffer += data.toString();
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() || "";
		for (const line of lines) handleJsonLine(line);
	});

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
			if (stdoutBuffer.trim()) {
				handleJsonLine(stdoutBuffer);
				stdoutBuffer = "";
			}
			updateWorkerProgress(true);
			try {
				jsonlStream.end();
			} catch {}
			try {
				fsSync.writeFileSync(artifactPaths.outputPath, rawOutput, { encoding: "utf-8", mode: 0o600 });
			} catch {}
			try {
				fsSync.writeFileSync(
					artifactPaths.metadataPath,
					JSON.stringify(
						{
							runId,
							workerId,
							identity,
							agent: config.agent,
							startedAt: startTime,
							completedAt: Date.now(),
							durationMs: Date.now() - startTime,
							toolCount,
							tokens,
							exitCode: code ?? 0,
						},
						null,
						2,
					),
					{ encoding: "utf-8", mode: 0o600 },
				);
			} catch {}
			if (tmpPromptDir) {
				try { fsSync.rmSync(tmpPromptDir, { recursive: true }); } catch {}
			}
			obs?.resources.trackRelease(workerId).catch(() => {});
			resolve(code ?? 0);
		});
		proc.on("error", () => {
			if (stdoutBuffer.trim()) {
				handleJsonLine(stdoutBuffer);
				stdoutBuffer = "";
			}
			updateWorkerProgress(true);
			try {
				jsonlStream.end();
			} catch {}
			if (tmpPromptDir) {
				try { fsSync.rmSync(tmpPromptDir, { recursive: true }); } catch {}
			}
			obs?.resources.trackRelease(workerId).catch(() => {});
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

export function createCoordinatorTools(): ToolDefinition[] {
	const coordDir = process.env.PI_COORDINATION_DIR;
	const identity = process.env.PI_AGENT_IDENTITY;

	if (!coordDir || !identity) {
		throw new Error("Coordinator tools require PI_COORDINATION_DIR and PI_AGENT_IDENTITY environment variables");
	}

	const storage = new FileBasedStorage(coordDir);
	let obs: ObservabilityContext | null = null;
	const getObs = (ctx: ExtensionContext) => {
		if (!obs) {
			obs = createWorkerObservability(coordDir, process.env.PI_TRACE_ID, identity, ctx.cwd, "coordinator");
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
				const obs = getObs(ctx);
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
						ctx.cwd,
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

						const structuredError = {
							id: `error-${handle.workerId}`,
							traceId: obs?.getTraceId() || "",
							spanId: "root",
							timestamp: Date.now(),
							category: "worker_crash" as const,
							severity: "error" as const,
							message: `Worker crashed with exit code ${exitCode}`,
							actor: handle.identity,
							phase: "workers" as const,
							recoverable: false,
							relatedWorkerId: handle.workerId,
						};

						await obs?.events.emit({
							type: "worker_failed",
							workerId: handle.workerId,
							error: structuredError,
						});

						await obs?.errors.capture(
							new Error(`Worker crashed with exit code ${exitCode}`),
							{
								category: "worker_crash",
								severity: "error",
								actor: handle.identity,
								phase: "workers",
								spanId: "root",
								recoverable: false,
								relatedWorkerId: handle.workerId,
							},
						);
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
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
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
			name: "broadcast_deviation",
			label: "Broadcast Deviation",
			description: "Notify affected workers when a deviation occurs",
			parameters: Type.Object({
				deviation: Type.String({ description: "What deviated from the plan" }),
				affectedWorkers: Type.Array(Type.String(), { description: "Worker identities to notify" }),
				adaptationHint: Type.Optional(Type.String({ description: "How workers should adapt" })),
			}),
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
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

				await obs?.events.emit({
					type: "deviation_broadcast",
					deviation: params.deviation,
					affectedWorkers: params.affectedWorkers,
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
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
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

		{
			name: "spawn_from_queue",
			label: "Spawn Workers from Queue",
			description: "Spawn workers based on pending tasks from the task queue. Each worker gets one task.",
			parameters: Type.Object({
				maxWorkers: Type.Optional(Type.Number({ description: "Maximum workers to spawn (default: no limit)" })),
				agentName: Type.Optional(Type.String({ description: "Agent to use (default: coordination/worker)" })),
				enableSupervisor: Type.Optional(Type.Boolean({ description: "Enable supervisor loop (default: true)" })),
			}),
			async execute(_toolCallId, params, _onUpdate, ctx) {
				const obs = getObs(ctx);
				const { TaskQueueManager } = await import("../task-queue.js");
				const { SupervisorLoop } = await import("../supervisor.js");

				const taskQueue = new TaskQueueManager(coordDir);
				const state = await storage.getState();
				let planContent = "";
				try {
					planContent = await fs.readFile(state.planPath, "utf-8");
				} catch {}

				const handles: (WorkerHandle & { taskId: string })[] = [];
				const maxWorkers = params.maxWorkers || Infinity;

				while (handles.length < maxWorkers) {
					const task = await taskQueue.getNextTask();
					if (!task) break;

					const claimed = await taskQueue.claimTask(task.id, identity);
					if (!claimed) continue;

					const workerId = randomUUID();
					const shortId = workerId.slice(0, 4);
					const workerIdentity = `worker:${task.id}-${shortId}`;

					await obs?.events.emit({
						type: "task_claimed",
						taskId: task.id,
						workerId: workerIdentity,
					});

					const handshakeSpec = `## Task: ${task.id}

${task.description}

### Files
${task.files?.map(f => `- ${f}`).join("\n") || "No specific files assigned"}

### Acceptance Criteria
${task.acceptanceCriteria?.map(c => `- ${c}`).join("\n") || "- Complete the task as described"}

${planContent ? `### Full Plan\n\`\`\`markdown\n${planContent}\n\`\`\`` : ""}
`;

					const handle = spawnWorkerProcess(
						{
							agent: params.agentName || "coordination/worker",
							handshakeSpec,
							steps: [],
							logicalName: task.id,
							workerId,
							identity: workerIdentity,
						},
						coordDir,
						ctx.cwd,
						storage,
						undefined,
						obs || undefined,
						params.agentName,
					);

					handles.push({ ...handle, taskId: task.id });
				}

				if (handles.length === 0) {
					return {
						content: [{ type: "text", text: "No pending tasks in queue" }],
					};
				}

				let supervisor: SupervisorLoop | null = null;
				const runtimeConfig = loadRuntimeConfig(coordDir);
				if (params.enableSupervisor !== false && runtimeConfig.supervisor?.enabled !== false) {
					supervisor = new SupervisorLoop(coordDir, storage, taskQueue, runtimeConfig.supervisor);
					supervisor.start(handles.map(h => ({ ...h, taskId: h.taskId })));
				}

				const allHandles = [...handles];
				const activeHandles = new Map(handles.map(h => [h.workerId, h]));
				const restartCounts = new Map<string, number>();

				const processWorkerExit = async (handle: WorkerHandle & { taskId: string }, exitCode: number) => {
					try {
						activeHandles.delete(handle.workerId);
						supervisor?.removeWorker(handle.workerId);

						if (exitCode === 0) {
							await taskQueue.markTaskComplete(handle.taskId, handle.identity);
							await obs?.events.emit({
								type: "task_completed",
								taskId: handle.taskId,
								workerId: handle.workerId,
								filesModified: [],
							});
						} else if (exitCode === 42) {
							const count = (restartCounts.get(handle.taskId) || 0) + 1;
							restartCounts.set(handle.taskId, count);

							if (count <= 2) {
								await taskQueue.releaseTask(handle.taskId);

								const task = (await taskQueue.getQueue()).tasks.find(t => t.id === handle.taskId);
								if (task && task.status === "pending") {
									const claimed = await taskQueue.claimTask(task.id, identity);
									if (claimed) {
										const newWorkerId = randomUUID();
										const shortId = newWorkerId.slice(0, 4);
										const workerIdentity = `worker:${task.id}-${shortId}-r${count}`;

										await obs?.events.emit({
											type: "worker_restarting",
											workerId: handle.workerId,
											restartCount: count,
										});

										const newHandshakeSpec = `## Task: ${task.id} (Restart ${count})

${task.description}

### Files
${task.files?.map(f => `- ${f}`).join("\n") || "No specific files assigned"}

### Acceptance Criteria
${task.acceptanceCriteria?.map(c => `- ${c}`).join("\n") || "- Complete the task as described"}

${planContent ? `### Full Plan\n\`\`\`markdown\n${planContent}\n\`\`\`` : ""}
`;

										const newHandle = spawnWorkerProcess(
											{
												agent: params.agentName || "coordination/worker",
												handshakeSpec: newHandshakeSpec,
												steps: [],
												logicalName: task.id,
												workerId: newWorkerId,
												identity: workerIdentity,
											},
											coordDir,
											ctx.cwd,
											storage,
											undefined,
											obs || undefined,
											params.agentName,
										);

										const handleWithTask = { ...newHandle, taskId: task.id };
										allHandles.push(handleWithTask);
										activeHandles.set(newWorkerId, handleWithTask);
										supervisor?.addWorker(handleWithTask);

										handleWithTask.promise.then(code => processWorkerExit(handleWithTask, code));
									}
								}
							} else {
								await taskQueue.markTaskFailed(handle.taskId, "Max restarts exceeded");
								await obs?.events.emit({
									type: "worker_abandoned",
									workerId: handle.workerId,
									reason: "Max restarts exceeded",
								});
							}
						} else {
							await taskQueue.markTaskFailed(handle.taskId, `exit code ${exitCode}`);
							await obs?.events.emit({
								type: "task_failed",
								taskId: handle.taskId,
								workerId: handle.workerId,
								reason: `exit code ${exitCode}`,
							});
						}
					} catch (err) {
						console.error(`Error processing worker exit for ${handle.workerId}:`, err);
						await obs?.events.emit({
							type: "task_failed",
							taskId: handle.taskId,
							workerId: handle.workerId,
							reason: `Error processing exit: ${err}`,
						});
					}
				};

				for (const handle of handles) {
					handle.promise.then(code => processWorkerExit(handle, code));
				}

				while (activeHandles.size > 0) {
					await new Promise(r => setTimeout(r, 500));
				}

				supervisor?.stop();

				const queue = await taskQueue.getQueue();
				const completed = queue.tasks.filter(t => t.status === "complete").length;
				const failed = queue.tasks.filter(t => t.status === "failed").length;
				const pending = queue.tasks.filter(t => t.status === "pending" || t.status === "claimed").length;

				return {
					content: [{
						type: "text",
						text: `Spawned ${allHandles.length} workers (${allHandles.length - handles.length} restarts).\nCompleted: ${completed}, Failed: ${failed}, Pending: ${pending}`,
					}],
					details: {
						workers: allHandles.map(h => ({ workerId: h.workerId, identity: h.identity, taskId: h.taskId })),
						queueStatus: { completed, failed, pending },
					},
				};
			},
		},

		{
			name: "get_task_queue_status",
			label: "Get Task Queue Status",
			description: "Get the current status of all tasks in the queue",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _onUpdate, _ctx) {
				const { TaskQueueManager } = await import("../task-queue.js");
				const taskQueue = new TaskQueueManager(coordDir);

				const queue = await taskQueue.getQueue();
				const statusCounts: Record<string, number> = {};

				for (const task of queue.tasks) {
					statusCounts[task.status] = (statusCounts[task.status] || 0) + 1;
				}

				const summary = queue.tasks.map(t => 
					`- ${t.id}: ${t.status}${t.claimedBy ? ` (${t.claimedBy})` : ""}`
				).join("\n");

				return {
					content: [{
						type: "text",
						text: `Task Queue Status:\n${Object.entries(statusCounts).map(([s, c]) => `${s}: ${c}`).join(", ")}\n\nTasks:\n${summary}`,
					}],
					details: { queue, statusCounts },
				};
			},
		},
	];

	return tools;
}

export function registerCoordinatorTools(pi: ExtensionAPI): void {
	for (const tool of createCoordinatorTools()) {
		pi.registerTool(tool);
	}
}
