import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CustomAgentTool, CustomToolFactory } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { discoverAgents, type AgentConfig } from "../subagent/agents.js";
import { getFinalOutput } from "../subagent/render.js";

import { runSingleAgent } from "../subagent/runner.js";
import type { SingleResult, SubagentDetails } from "../subagent/types.js";
import { FileBasedStorage } from "./state.js";
import { generateCoordinationLog } from "./log-generator.js";
import { CheckpointManager } from "./checkpoint.js";
import {
	type PipelineConfig,
	type PipelineContext,
	initializePipelineState,
	initializeCostState,
	updatePhaseStatus,
	saveProgressDoc,
	runScoutPhaseWrapper,
	runReviewFixLoop,
} from "./pipeline.js";
import type { CoordinationState, CoordinationEvent, WorkerStateFile, WorkerStatus, CoordinationStatus, PipelinePhase, PhaseResult, CostState } from "./types.js";
import type { ReviewResult } from "./phases/review.js";
import { ObservabilityContext } from "./observability/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

interface WorkerInfo {
	id: string;
	shortId: string;
	identity: string;
	agent: string;
	status: WorkerStatus;
	currentFile: string | null;
	currentTool: string | null;
	waitingFor: { identity: string; item: string } | null;
	startedAt: number;
	completedAt: number | null;
	usage: { input: number; output: number; cost: number; turns: number };
	filesModified: string[];
}

interface CoordinationDetails {
	sessionId: string;
	coordDir: string;
	status: CoordinationStatus | "unknown";
	coordinatorResult: SingleResult;
	workers: WorkerInfo[];
	events: CoordinationEvent[];
	pendingAgents: string[];
	deviations: string[];
	startedAt: number;
	pipeline?: {
		currentPhase: PipelinePhase;
		phases: Record<PipelinePhase, PhaseResult>;
		fixCycle: number;
	};
	cost?: CostState;
}

type OnUpdateCallback = (partial: AgentToolResult<CoordinationDetails>) => void;

const CoordinateParams = Type.Object({
	plan: Type.String({ description: "Path to markdown plan file" }),
	agents: Type.Array(Type.String(), { description: "Agent types to use (e.g. ['worker', 'worker'])" }),
	logPath: Type.Optional(Type.String({ description: "Path for coordination log output. Defaults to cwd. Set to empty string to disable." })),
	resume: Type.Optional(Type.String({ description: "Checkpoint ID to resume from" })),
	maxFixCycles: Type.Optional(Type.Number({ description: "Maximum review/fix cycles (default: 3)" })),
	sameIssueLimit: Type.Optional(Type.Number({ description: "Times same issue can recur before giving up (default: 2)" })),
	reviewModel: Type.Optional(Type.String({ description: "Model for code review phase" })),
	checkTests: Type.Optional(Type.Boolean({ description: "Whether reviewer should check for tests (default: true)" })),
	costThresholds: Type.Optional(Type.Object({
		warn: Type.Number({ description: "Cost threshold for warning ($)", default: 1.0 }),
		pause: Type.Number({ description: "Cost threshold to pause and confirm ($)", default: 5.0 }),
		hard: Type.Number({ description: "Cost threshold to abort ($)", default: 10.0 }),
	})),
	pauseOnCostThreshold: Type.Optional(Type.Boolean({ description: "Block and ask user when pause threshold is hit (default: false)" })),
});

function buildCoordinatorTask(
	planContent: string,
	scoutContext: string,
	agents: string[],
	coordDir: string,
): string {
	return `## Coordination Session

You are managing a coordination session. Your job is to spawn worker agents and summarize results.
${scoutContext ? `
### Scout Context
${scoutContext}
` : ""}
### Plan to Execute
\`\`\`markdown
${planContent}
\`\`\`

### Available Agent Types
${agents.join(", ")}

### Coordination Directory
${coordDir}

### Workflow

1. **Analyze the plan for dependencies**
   - Identify which steps depend on outputs from other steps
   - For each dependency, note: what is being produced, who produces it, who needs it

2. **Pre-assign file ownership** (optional but recommended for complex plans)
   - Call assign_files() to declare which files each worker owns BEFORE spawning workers
   - Use logical names like "worker-A", "worker-B"
   - First worker to own a file gets it; later workers needing the same file wait via contract

3. **Create contracts for dependencies** (if any exist)
   - Call create_contract() for each cross-worker dependency BEFORE spawning workers
   - Use logical worker names (worker-A, worker-B, etc.) that match spawn_workers logicalName
   - Workers will use wait_for_contract() to block until dependencies are ready
   - Workers will use signal_contract_complete() when they finish producing the dependency

4. **Call spawn_workers()** with detailed handshake specs
   - This spawns workers in parallel and WAITS for all to complete
   - Each worker needs: agent type, logicalName, step numbers, and detailed handshakeSpec
   - If worker depends on another, include "Wait for contract 'X' before starting" in handshakeSpec
   - If worker provides something others need, include "Signal contract 'X' when complete" in handshakeSpec
   - Use adjacentWorkers to indicate which workers interact with each other
   
5. **Call done()** with a summary of what was accomplished
   - done() validates that workers were spawned and completed successfully

### Example with Dependencies (Diamond Pattern):
\`\`\`
// Step 1: Pre-assign files (optional)
assign_files({ workerLogicalName: "worker-A", files: ["src/types.ts"] })
assign_files({ workerLogicalName: "worker-B", files: ["src/service.ts"] })
assign_files({ workerLogicalName: "worker-C", files: ["src/validator.ts"] })

// Step 2: Create contract for the dependency
create_contract({
  item: "User type",
  type: "type", 
  provider: "worker-A",
  waiters: ["worker-B", "worker-C"],
  signature: "interface User { id: string; name: string; }"
})

// Step 3: Spawn workers with dependency info in handshakeSpec
spawn_workers({
  workers: [
    {
      "agent": "worker",
      "logicalName": "worker-A",
      "steps": [1],
      "adjacentWorkers": ["worker-B", "worker-C"],
      "handshakeSpec": "Create src/types.ts with User interface (id: string, name: string). After creating the file, call signal_contract_complete({ item: 'User type', file: 'src/types.ts' })."
    },
    {
      "agent": "worker",
      "logicalName": "worker-B",
      "steps": [2],
      "adjacentWorkers": ["worker-A"],
      "handshakeSpec": "First call wait_for_contract({ item: 'User type' }) to wait for the User type to be ready. Then create src/service.ts with createUser function that imports User from ./types."
    },
    {
      "agent": "worker",
      "logicalName": "worker-C",
      "steps": [3],
      "adjacentWorkers": ["worker-A"],
      "handshakeSpec": "First call wait_for_contract({ item: 'User type' }) to wait for the User type to be ready. Then create src/validator.ts with validateUser function that imports User from ./types."
    }
  ]
})
\`\`\`

### Example without Dependencies (Parallel):
\`\`\`
// No contracts needed - just spawn workers
spawn_workers({
  workers: [
    {"agent": "worker", "logicalName": "worker-A", "steps": [1], "handshakeSpec": "Create src/file1.ts with a hello() function returning 'hello'."},
    {"agent": "worker", "logicalName": "worker-B", "steps": [2], "handshakeSpec": "Create src/file2.ts with a world() function returning 'world'."}
  ]
})
\`\`\`

### handshakeSpec Guidelines
- Be specific about file paths, function names, types
- Include what to import and export
- Describe the expected implementation details
- For providers: include "call signal_contract_complete({ item: 'X' }) when done"
- For waiters: include "call wait_for_contract({ item: 'X' }) before starting work"`;
}

const factory: CustomToolFactory = (pi) => {
	const tool: CustomAgentTool<typeof CoordinateParams, CoordinationDetails> = {
		name: "coordinate",
		label: "Coordinate",
		description:
			"Start multi-agent coordination session. Splits a plan across parallel workers, manages dependencies, and returns unified results. Saves a markdown log to the project directory (configurable via logPath parameter or PI_COORDINATION_LOG_DIR env var).",
		parameters: CoordinateParams,

		async execute(_toolCallId, params, signal, onUpdate) {
			const coordSessionId = randomUUID();
			const sessionDir = process.env.PI_SESSION_DIR || path.join(os.homedir(), ".pi", "sessions", "default");
			const coordDir = path.join(sessionDir, "coordination", coordSessionId);

			const storage = new FileBasedStorage(coordDir);
			await storage.initialize();

			const planPath = path.resolve(pi.cwd, params.plan);
			const planDir = path.dirname(planPath);
			let planContent: string;
			try {
				planContent = await fs.readFile(planPath, "utf-8");
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to read plan file: ${planPath}\n${err}` }],
					isError: true,
				};
			}

			const initialState: CoordinationState = {
				sessionId: coordSessionId,
				planPath,
				planHash: hash(planContent),
				status: "analyzing",
				contracts: {},
				deviations: [],
				startedAt: Date.now(),
			};
			await storage.setState(initialState);

			process.env.PI_ACTIVE_COORDINATION_DIR = coordDir;
			process.env.PI_COORDINATION_DIR = coordDir;
			process.env.PI_AGENT_IDENTITY = "coordinator";

			const coordinatorToolsPath = path.join(__dirname, "coordinator-tools", "index.ts");

			const discovery = discoverAgents(pi.cwd, "user");
			const agents = discovery.agents;

			const coordinatorAgent = agents.find(a => a.name === "coordinator");
			if (!coordinatorAgent) {
				delete process.env.PI_ACTIVE_COORDINATION_DIR;
				delete process.env.PI_COORDINATION_DIR;
				delete process.env.PI_AGENT_IDENTITY;
				return {
					content: [{ type: "text", text: "Coordinator agent not found. Create ~/.pi/agent/agents/coordinator.md" }],
					isError: true,
				};
			}

			const augmentedAgents: AgentConfig[] = agents.map(a => {
				if (a.name === "coordinator") {
					return {
						...a,
						tools: [...(a.tools || []), coordinatorToolsPath],
					};
				}
				return a;
			});

			const checkpointManager = new CheckpointManager(coordDir);
			
			let pipelineState = initializePipelineState(
				coordSessionId,
				planPath,
				hash(planContent),
				params.maxFixCycles ?? 3,
			);
			let costState = initializeCostState(params.costThresholds);
			let reviewHistory: ReviewResult[] = [];
			let resumeFromPhase: PipelinePhase | null = null;

			if (params.resume) {
				try {
					const restored = await checkpointManager.restoreFromCheckpoint(params.resume, storage);
					pipelineState = restored.pipelineState;
					resumeFromPhase = restored.nextPhase;
					if (restored.costState) {
						costState = restored.costState;
					}
					if (restored.reviewHistory) {
						reviewHistory = restored.reviewHistory.map(issues => ({
							issues,
							summary: "(restored from checkpoint)",
							allPassing: issues.length === 0,
							filesReviewed: [],
							duration: 0,
							cost: 0,
						}));
					}
				} catch (err) {
					return {
						content: [{ type: "text", text: `Failed to restore from checkpoint: ${params.resume}\n${err}` }],
						isError: true,
					};
				}
			}

			const pipelineConfig: PipelineConfig = {
				planPath,
				planContent,
				planDir,
				coordDir,
				sessionId: coordSessionId,
				agents: params.agents,
				maxFixCycles: params.maxFixCycles ?? 3,
				sameIssueLimit: params.sameIssueLimit ?? 2,
				reviewModel: params.reviewModel,
				checkTests: params.checkTests ?? true,
				costThresholds: costState.thresholds,
				pauseOnCostThreshold: params.pauseOnCostThreshold ?? false,
			};

			const obs = await ObservabilityContext.create(
				coordDir,
				pi.cwd,
				"coordinator",
				"system",
			);

			process.env.PI_TRACE_ID = obs.getTraceId();

			await obs.events.emit({
				type: "session_started",
				config: {
					planPath,
					agents: params.agents,
					maxFixCycles: params.maxFixCycles ?? 3,
					sameIssueLimit: params.sameIssueLimit ?? 2,
					costThresholds: costState.thresholds,
				},
			});

			const pipelineContext: PipelineContext = {
				pi,
				storage,
				checkpointManager,
				pipelineState,
				costState,
				reviewHistory,
				signal,
				onUpdate,
				obs,
			};

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				results,
			});

			const makeCoordDetails = (
				result: SingleResult,
				state?: CoordinationState,
				workerStates?: WorkerStateFile[],
				events?: CoordinationEvent[],
				pendingAgents?: string[]
			): CoordinationDetails => {
				const workers: WorkerInfo[] = (workerStates || []).map(w => ({
					id: w.id,
					shortId: w.shortId,
					identity: w.identity,
					agent: w.agent,
					status: w.status,
					currentFile: w.currentFile,
					currentTool: w.currentTool,
					waitingFor: w.waitingFor,
					startedAt: w.startedAt,
					completedAt: w.completedAt,
					usage: w.usage,
					filesModified: w.filesModified,
				}));

				return {
					sessionId: coordSessionId,
					coordDir,
					status: state?.status || "unknown",
					coordinatorResult: result,
					workers,
					events: events || [],
					pendingAgents: pendingAgents || [],
					deviations: state?.deviations?.map(d => d.description) || [],
					startedAt: state?.startedAt || Date.now(),
				};
			};

			let statusInterval: NodeJS.Timeout | null = null;
			let lastCoordResult: SingleResult = { agent: "coordinator", agentSource: "user", task: "", exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
			let lastMilestoneThreshold = 0;

			const coordOnUpdate: typeof onUpdate = onUpdate ? (partial) => {
				const result = partial.details?.results[0];
				if (result) {
					lastCoordResult = result;
					storage.getState().then(async state => {
						const workerStates = await storage.listWorkerStates();
						const events = await storage.getEvents();
						onUpdate({
							content: [{ type: "text", text: "coordinating..." }],
							details: makeCoordDetails(result, state, workerStates, events, params.agents),
						});
					}).catch(() => {
						onUpdate({
							content: [{ type: "text", text: "working..." }],
							details: makeCoordDetails(result, undefined, undefined, undefined, params.agents),
						});
					});
				}
			} : undefined;

			if (onUpdate) {
				statusInterval = setInterval(async () => {
					try {
						const state = await storage.getState();
						const workerStates = await storage.listWorkerStates();
						const events = await storage.getEvents();

						const aggregateCost = workerStates.reduce((sum, w) => sum + w.usage.cost, 0);
						const currentMilestone = Math.floor(aggregateCost / 0.25) * 0.25;
						if (currentMilestone > lastMilestoneThreshold && currentMilestone > 0) {
							lastMilestoneThreshold = currentMilestone;
							await storage.appendEvent({
								type: "cost_milestone",
								threshold: currentMilestone,
								totals: Object.fromEntries(workerStates.map(w => [w.id, w.usage.cost])),
								aggregate: aggregateCost,
								timestamp: Date.now(),
							});
						}

						onUpdate({
							content: [{ type: "text", text: "coordinating..." }],
							details: makeCoordDetails(lastCoordResult, state, workerStates, events, params.agents),
						});
					} catch {}
				}, 200);
			}

			try {
				let coordExitError = false;
				let coordinatorResult: SingleResult = lastCoordResult;

				const shouldRunPhase = (phase: PipelinePhase): boolean => {
					if (!resumeFromPhase) return true;
					const phaseOrder: PipelinePhase[] = ["scout", "coordinator", "workers", "review", "fixes", "complete"];
					const resumeIdx = phaseOrder.indexOf(resumeFromPhase);
					const phaseIdx = phaseOrder.indexOf(phase);
					return phaseIdx >= resumeIdx;
				};

				if (shouldRunPhase("scout")) {
					await runScoutPhaseWrapper(pipelineContext, pipelineConfig);
				}

				const scoutContext = pipelineState.scoutContext || "";

				if (shouldRunPhase("coordinator")) {
					const coordSpan = obs.spans.startSpan("phase:coordinator", "phase");
					await obs.snapshots.capture("phase_start", "coordinator");

					const task = buildCoordinatorTask(planContent, scoutContext, params.agents, coordDir);

					updatePhaseStatus("coordinator", "running", pipelineContext);
					coordinatorResult = await runSingleAgent(
						pi,
						augmentedAgents,
						"coordinator",
						task,
						planDir,
						undefined,
						signal,
						coordOnUpdate,
						makeDetails,
					);
					lastCoordResult = coordinatorResult;

					const workerStatesAfterCoord = await storage.listWorkerStates();
					const workerCost = workerStatesAfterCoord.reduce((sum, w) => sum + w.usage.cost, 0);
					costState.byPhase.coordinator = coordinatorResult.usage.cost;
					costState.byPhase.workers = workerCost;
					costState.total += coordinatorResult.usage.cost + workerCost;

					await obs.events.emit({
						type: "cost_updated",
						delta: coordinatorResult.usage.cost + workerCost,
						total: costState.total,
						breakdown: { byPhase: costState.byPhase, byWorker: costState.byWorker },
					});

					const checkpointId = await checkpointManager.saveCheckpoint(
						"coordinator",
						pipelineState,
						costState,
						reviewHistory.map(r => r.issues),
					);
					await obs.events.emit({ type: "checkpoint_saved", checkpointId, phase: "coordinator" });

					await saveProgressDoc(pipelineContext);
					await obs.snapshots.capture("phase_end", "coordinator");
					obs.spans.endSpan(coordSpan.id, "ok", {
						workerCount: workerStatesAfterCoord.length,
					}, {
						cost: coordinatorResult.usage.cost + workerCost,
					});
					updatePhaseStatus("coordinator", "complete", pipelineContext);
					updatePhaseStatus("workers", "complete", pipelineContext);

					coordExitError = coordinatorResult.exitCode !== 0 || coordinatorResult.stopReason === "error" || coordinatorResult.stopReason === "aborted";
				}

				if (!coordExitError && shouldRunPhase("review")) {
					await runReviewFixLoop(pipelineContext, pipelineConfig);
				}

				updatePhaseStatus("complete", "complete", pipelineContext);
				pipelineState.completedAt = Date.now();

				const finalState = await storage.getState();
				const workerStates = await storage.listWorkerStates();
				const events = await storage.getEvents();
				const completedAt = Date.now();

				const detailsWithPipeline: CoordinationDetails = {
					...makeCoordDetails(coordinatorResult, finalState, workerStates, events, params.agents),
					pipeline: {
						currentPhase: pipelineState.currentPhase,
						phases: pipelineState.phases,
						fixCycle: pipelineState.fixCycle,
					},
					cost: costState,
				};

				const isError = coordExitError || pipelineState.exitReason === "cost_abort" || pipelineState.exitReason === "stuck";

				let summary: string;
				if (pipelineState.exitReason === "clean") {
					summary = "Coordination completed successfully - all review checks passed";
				} else if (pipelineState.exitReason === "stuck") {
					summary = `Coordination completed with unresolved issues after ${pipelineState.fixCycle} fix cycles`;
				} else if (pipelineState.exitReason === "max_cycles") {
					summary = `Coordination completed - max fix cycles (${pipelineState.maxFixCycles}) reached`;
				} else if (pipelineState.exitReason === "cost_abort") {
					summary = `Coordination aborted - cost threshold exceeded ($${costState.total.toFixed(2)})`;
				} else {
					summary = getFinalOutput(coordinatorResult.messages) ||
						(finalState.status === "complete" ? "Coordination completed" : `Coordination ended: ${finalState.status}`);
				}

				let logFilePath: string | undefined;
				if (params.logPath !== "") {
					try {
						const logContent = generateCoordinationLog({
							sessionId: coordSessionId,
							coordDir,
							planPath,
							planContent,
							state: finalState,
							workerStates,
							events,
							coordinatorResult,
							startedAt: initialState.startedAt,
							completedAt,
							pipelineState,
							reviewHistory,
							costState,
						});

						const logDir = params.logPath
							? path.resolve(pi.cwd, params.logPath)
							: process.env.PI_COORDINATION_LOG_DIR
								? path.resolve(process.env.PI_COORDINATION_LOG_DIR)
								: pi.cwd;
						
						const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
						const logFileName = `coordination-log-${timestamp}.md`;
						logFilePath = path.join(logDir, logFileName);

						await fs.mkdir(logDir, { recursive: true });
						await fs.writeFile(logFilePath, logContent, "utf-8");
					} catch (logErr) {
						console.error(`Failed to write coordination log: ${logErr}`);
					}
				}

				const summaryWithLog = logFilePath
					? `${summary}\n\nLog saved to: ${logFilePath}`
					: summary;

				await obs.events.emit({
					type: "session_completed",
					summary: {
						status: isError ? "failed" : "complete",
						duration: completedAt - initialState.startedAt,
						totalCost: costState.total,
						workersSpawned: workerStates.length,
						workersCompleted: workerStates.filter(w => w.status === "complete").length,
						workersFailed: workerStates.filter(w => w.status === "failed").length,
						filesModified: [...new Set(workerStates.flatMap(w => w.filesModified))],
						reviewCycles: pipelineState.fixCycle,
						exitReason: pipelineState.exitReason,
					},
				});

				return {
					content: [{ type: "text", text: summaryWithLog }],
					details: detailsWithPipeline,
					isError,
				};
			} catch (err) {
				await obs.errors.capture(err, {
					category: "system_error",
					severity: "fatal",
					actor: "coordinator",
					phase: pipelineState.currentPhase,
					spanId: "root",
					recoverable: false,
				});

				const failedWorkerStates = await storage.listWorkerStates().catch(() => []);
				await obs.events.emit({
					type: "session_completed",
					summary: {
						status: "failed",
						duration: Date.now() - initialState.startedAt,
						totalCost: costState.total,
						workersSpawned: failedWorkerStates.length,
						workersCompleted: failedWorkerStates.filter(w => w.status === "complete").length,
						workersFailed: failedWorkerStates.filter(w => w.status === "failed").length,
						filesModified: [...new Set(failedWorkerStates.flatMap(w => w.filesModified))],
						reviewCycles: pipelineState.fixCycle,
						exitReason: "error",
					},
				});

				updatePhaseStatus("failed", "failed", pipelineContext, String(err));
				return {
					content: [{ type: "text", text: `Coordination failed: ${err}` }],
					isError: true,
				};
			} finally {
				if (statusInterval) {
					clearInterval(statusInterval);
				}
				delete process.env.PI_ACTIVE_COORDINATION_DIR;
				delete process.env.PI_COORDINATION_DIR;
				delete process.env.PI_AGENT_IDENTITY;
				delete process.env.PI_TRACE_ID;
			}
		},

		renderCall(args, theme) {
			const planPath = args.plan || "...";
			const agentCount = args.agents?.length || 0;
			let text = theme.fg("toolTitle", theme.bold("coordinate ")) +
				theme.fg("accent", planPath) +
				theme.fg("muted", ` (${agentCount} agents)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const { details } = result;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const container = new Container();
			const isError = result.isError;
			const icon = isError ? theme.fg("error", "x") : theme.fg("success", "ok");
			const workers = details.workers || [];
			const events = details.events || [];
			const allDone = workers.length > 0 &&
				workers.every(w => w.status === "complete" || w.status === "failed");

			if (details.pipeline) {
				const phases: PipelinePhase[] = ["scout", "coordinator", "workers", "review", "fixes", "complete"];
				const current = details.pipeline.currentPhase;

				let timeline = "";
				for (const phase of phases) {
					const status = details.pipeline.phases[phase]?.status;

					if (status === "complete") {
						timeline += theme.fg("success", `[${phase}]`) + " -> ";
					} else if (status === "running") {
						timeline += theme.fg("warning", `[${phase}]`) + " -> ";
					} else if (status === "failed") {
						timeline += theme.fg("error", `[${phase}]`) + " -> ";
					} else {
						timeline += theme.fg("muted", `[${phase}]`) + " -> ";
					}
				}

				container.addChild(new Text(`Pipeline: ${timeline.slice(0, -4)}`, 0, 0));
				container.addChild(new Text(`Current: ${current}`, 0, 0));
				if (details.cost) {
					container.addChild(new Text(
						`Cost: $${details.cost.total.toFixed(2)} / $${details.cost.thresholds.pause.toFixed(2)} pause threshold`,
						0, 0
					));
				}
				container.addChild(new Text("", 0, 0));
			}

			const formatElapsed = (ms: number): string => {
				const secs = Math.floor(ms / 1000);
				if (secs < 60) return `${secs}s`;
				const mins = Math.floor(secs / 60);
				const remainingSecs = secs % 60;
				return `${mins}m${remainingSecs}s`;
			};

			const statusColor = (status: string): string => {
				switch (status) {
					case "complete": return "success";
					case "failed": case "blocked": return "error";
					case "working": return "warning";
					case "waiting": return "muted";
					default: return "dim";
				}
			};

			if (allDone) {
				const totalTime = Date.now() - (details.startedAt || Date.now());
				const totalCost = workers.reduce((sum, w) => sum + w.usage.cost, 0);
				const failed = workers.filter(w => w.status === "failed").length;

				const headerText = failed > 0
					? `Coordination Failed (${formatElapsed(totalTime)} elapsed, $${totalCost.toFixed(2)} spent)`
					: `Coordination Complete (${formatElapsed(totalTime)} total, $${totalCost.toFixed(2)})`;

				container.addChild(new Text(
					failed > 0 ? theme.fg("error", headerText) : theme.fg("success", headerText),
					0, 0
				));
				container.addChild(new Text("", 0, 0));

				container.addChild(new Text(
					theme.fg("muted", "| Worker      | Time   | Cost  | Turns | Files Modified"),
					0, 0
				));
				container.addChild(new Text(
					theme.fg("muted", "|-------------|--------|-------|-------|---------------"),
					0, 0
				));

				for (const w of workers) {
					const time = w.completedAt && w.startedAt
						? formatElapsed(w.completedAt - w.startedAt)
						: "--";
					const cost = `$${w.usage.cost.toFixed(2)}`;
					const turns = w.usage.turns.toString();
					const files = w.filesModified.slice(0, 2).join(", ") +
						(w.filesModified.length > 2 ? "..." : "");
					const statusIcon = w.status === "complete"
						? theme.fg("success", "ok")
						: theme.fg("error", "FAILED");

					container.addChild(new Text(
						`| ${statusIcon} ${theme.fg("accent", `worker:${w.shortId}`)} | ${time.padEnd(6)} | ${cost.padEnd(5)} | ${turns.padEnd(5)} | ${files}`,
						0, 0
					));
				}

				const output = getFinalOutput(details.coordinatorResult?.messages || []);
				if (output) {
					container.addChild(new Text("", 0, 0));
					container.addChild(new Text(theme.fg("muted", "--- Coordinator Summary ---"), 0, 0));
					const lines = output.split("\n").slice(0, 15);
					for (const line of lines) {
						container.addChild(new Text(theme.fg("dim", line.slice(0, 100)), 0, 0));
					}
				}

				return container;
			}

			const complete = workers.filter(w => w.status === "complete").length;
			container.addChild(new Text(
				`${icon} ${complete}/${workers.length || details.pendingAgents?.length || 0} workers`,
				0, 0
			));

			if (workers.length > 0) {
				for (let i = 0; i < workers.length; i += 2) {
					let line = "";
					for (let j = i; j < Math.min(i + 2, workers.length); j++) {
						const w = workers[j];
						const elapsed = formatElapsed(Date.now() - w.startedAt);
						const displayFile = w.currentFile 
							|| (w.filesModified.length > 0 ? w.filesModified[w.filesModified.length - 1] : null);
						const file = displayFile
							? path.basename(displayFile).slice(0, 12).padEnd(12)
							: "----".padEnd(12);
						const statusText = w.status === "waiting" && w.waitingFor
							? `wait:${w.waitingFor.identity.split("-").pop()}`
							: w.status;

						line += `${theme.fg("accent", `worker:${w.shortId}`)} `;
						line += `${theme.fg("dim", file)} `;
						line += `${theme.fg(statusColor(w.status), statusText.padEnd(8))} `;
						line += `${theme.fg("muted", elapsed.padEnd(6))}  `;
					}
					container.addChild(new Text(line, 0, 0));
				}
			} else if (details.pendingAgents && details.pendingAgents.length > 0) {
				const spinnerFrames = ["|", "/", "-", "\\"];
				const frameIndex = Math.floor(Date.now() / 80) % spinnerFrames.length;
				const spinner = spinnerFrames[frameIndex];
				let line = "";
				for (const agent of details.pendingAgents) {
					line += `${theme.fg("warning", spinner)} ${theme.fg("accent", agent)}  `;
				}
				container.addChild(new Text(line, 0, 0));
			}

			if (events.length > 0) {
				container.addChild(new Text(theme.fg("muted", "---"), 0, 0));
				const recentEvents = events.slice(-10);
				const firstTs = events[0]?.timestamp || Date.now();

				for (const ev of recentEvents) {
					const elapsed = `+${((ev.timestamp - firstTs) / 1000).toFixed(1)}s`;
					let shortId: string;
					if (ev.type === "cost_milestone" || ev.type === "cost_warning" || ev.type === "cost_pause") {
						shortId = "$";
					} else if (ev.type === "phase_complete") {
						shortId = "sys";
					} else if (ev.type === "coordinator") {
						shortId = "co";
					} else {
						shortId = (ev as { workerId?: string }).workerId?.slice(0, 4) || "??";
					}

					let line = `${theme.fg("muted", elapsed.padEnd(8))}`;
					line += `${theme.fg("accent", `[${shortId}]`)} `;

					switch (ev.type) {
						case "tool_call":
							line += theme.fg("dim", `${ev.tool}${ev.file ? ` ${path.basename(ev.file)}` : ""}`);
							break;
						case "tool_result":
							line += theme.fg("dim", `${ev.tool} ${ev.success ? "ok" : "error"}`);
							break;
						case "waiting":
							const waiterId = ev.waitingFor.split("-").pop() || "??";
							line += theme.fg("warning", `waiting for ${ev.item} from ${waiterId}`);
							break;
						case "contract_received":
							const fromId = ev.from.split("-").pop() || "??";
							line += theme.fg("success", `received contract from ${fromId}`);
							break;
						case "worker_started":
							line += theme.fg("success", "started");
							break;
						case "worker_completed":
							line += theme.fg("success", "complete_task (done)");
							break;
						case "worker_failed":
							line += theme.fg("error", `FAILED: ${ev.error}`);
							break;
						case "cost_milestone":
							const totals = Object.entries(ev.totals)
								.map(([id, cost]) => `${id.slice(0, 4)}: $${cost.toFixed(2)}`)
								.join(" | ");
							line += theme.fg("muted", `${totals} | total: $${ev.aggregate.toFixed(2)}`);
							break;
						case "coordinator":
							line += theme.fg("dim", ev.message.slice(0, 50));
							break;
						case "phase_complete":
							line += theme.fg("success", `phase ${ev.phase} done ($${ev.cost.toFixed(2)})`);
							break;
						case "cost_warning":
							line += theme.fg("warning", `cost warning: $${ev.total.toFixed(2)}`);
							break;
						case "cost_pause":
							line += theme.fg("error", `cost pause: $${ev.total.toFixed(2)}`);
							break;
					}

					container.addChild(new Text(line, 0, 0));
				}
			}

			return container;
		},
	};

	return tool;
};

export default factory;
