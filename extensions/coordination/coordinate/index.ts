import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { EventBus, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { discoverAgents, type AgentConfig } from "../subagent/agents.js";
import { getResultOutput } from "../subagent/render.js";

interface CoordinationSettings {
	agents?: string[] | number;
	planner?: boolean | { enabled?: boolean; humanCheckpoint?: boolean; maxSelfReviewCycles?: number };
	reviewCycles?: number | false;
	supervisor?: boolean | { enabled?: boolean; nudgeThresholdMs?: number; restartThresholdMs?: number; maxRestarts?: number; checkIntervalMs?: number };
	costLimit?: number;
	maxFixCycles?: number;
	checkTests?: boolean;
}

interface NormalizedSettings {
	agents?: string[];
	planner?: { enabled?: boolean; humanCheckpoint?: boolean; maxSelfReviewCycles?: number };
	reviewCycles?: number | false;
	supervisor?: { enabled?: boolean; nudgeThresholdMs?: number; restartThresholdMs?: number; maxRestarts?: number; checkIntervalMs?: number };
	costLimit?: number;
	maxFixCycles?: number;
	checkTests?: boolean;
}

function normalizeSettings(raw: CoordinationSettings): NormalizedSettings {
	return {
		agents: typeof raw.agents === "number" ? Array(raw.agents).fill("worker") : raw.agents,
		planner: typeof raw.planner === "boolean" ? { enabled: raw.planner } : raw.planner,
		reviewCycles: raw.reviewCycles,
		supervisor: typeof raw.supervisor === "boolean" ? { enabled: raw.supervisor } : raw.supervisor,
		costLimit: raw.costLimit,
		maxFixCycles: raw.maxFixCycles,
		checkTests: raw.checkTests,
	};
}

function loadCoordinationSettings(): NormalizedSettings {
	const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
	try {
		if (!fsSync.existsSync(settingsPath)) return {};
		const content = fsSync.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(content);
		return normalizeSettings(settings.coordination ?? {});
	} catch {
		return {};
	}
}

import { runSingleAgent, type AgentRuntime } from "../subagent/runner.js";
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
	runPlannerPhaseWrapper,
	runReviewFixLoop,
} from "./pipeline.js";
import type { CoordinationState, CoordinationEvent, WorkerStateFile, WorkerStatus, CoordinationStatus, PipelinePhase, PhaseResult, CostState } from "./types.js";
import type { ReviewResult } from "./phases/review.js";
import { ObservabilityContext } from "./observability/index.js";
import { validateCoordination } from "./validation/index.js";
import type { ValidationResult } from "./validation/types.js";
import { createStreamingValidator, type StreamingValidator } from "./validation/streaming.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ASYNC_RESULTS_DIR = "/tmp/pi-async-coordination-results";
const ASYNC_STALE_MS = 60 * 60 * 1000;
const PROGRESS_EMIT_INTERVAL_MS = 500;
const jitiCliPath: string | undefined = (() => {
	try {
		return path.join(path.dirname(require.resolve("jiti/package.json")), "lib/jiti-cli.mjs");
	} catch {
		return undefined;
	}
})();

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function writeSharedContextFile(
	filePath: string,
	planContent: string,
	scoutContext: string,
): Promise<void> {
	const parts: string[] = [];
	parts.push("# Coordination Shared Context");
	parts.push(`Generated: ${new Date().toISOString()}`);
	parts.push("## Plan");
	parts.push(planContent.trim() ? planContent : "(empty)");
	if (scoutContext.trim()) {
		parts.push("## Scout Context");
		parts.push(scoutContext);
	}
	await fs.writeFile(filePath, parts.join("\n\n"), "utf-8");
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
	toolCount?: number;
	tokens?: number;
	durationMs?: number;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
	lastOutput?: string;
	artifactsDir?: string;
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
	validation?: ValidationResult;
	async?: {
		id: string;
		status: "queued" | "complete" | "failed";
		resultPath: string;
		resultsDir: string;
		coordDir: string;
	};
}

type OnUpdateCallback = (partial: AgentToolResult<CoordinationDetails>) => void;

interface CoordinationRuntime extends AgentRuntime {
	events: EventBus;
}

const CoordinateParams = Type.Object({
	plan: Type.String({ description: "Path to markdown plan file" }),
	agents: Type.Optional(Type.Union([
		Type.Array(Type.String()),
		Type.Number(),
	], { description: "Worker agents: array of names or count (default: 4 workers)" })),
	logPath: Type.Optional(Type.String({ description: "Path for coordination log output. Defaults to cwd. Set to empty string to disable." })),
	resume: Type.Optional(Type.String({ description: "Checkpoint ID to resume from" })),
	maxFixCycles: Type.Optional(Type.Number({ description: "Maximum review/fix cycles (default: 3)" })),
	sameIssueLimit: Type.Optional(Type.Number({ description: "Times same issue can recur before giving up (default: 2)" })),
	checkTests: Type.Optional(Type.Boolean({ description: "Whether reviewer should check for tests (default: true)" })),
	async: Type.Optional(Type.Boolean({ description: "Run coordination in background (default: false)" })),
	asyncResultsDir: Type.Optional(Type.String({ description: "Override async results directory" })),
	maxOutput: Type.Optional(Type.Object({
		bytes: Type.Optional(Type.Number({ description: "Max output bytes to return from subagents" })),
		lines: Type.Optional(Type.Number({ description: "Max output lines to return from subagents" })),
	})),
	costLimit: Type.Optional(Type.Number({ description: "Cost limit in dollars - ends gracefully before next review cycle (default: 40)" })),
	validate: Type.Optional(Type.Boolean({ description: "Run validation after completion (default: false)" })),
	validateStream: Type.Optional(Type.Boolean({ description: "Stream invariant warnings in real-time (default: false)" })),
	scout: Type.Optional(Type.Union([
		Type.String(),
		Type.Object({ model: Type.Optional(Type.String()) }),
	], { description: "Scout config: string sets model, object for full config" })),
	planner: Type.Optional(Type.Union([
		Type.Boolean(),
		Type.String(),
		Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			model: Type.Optional(Type.String()),
			humanCheckpoint: Type.Optional(Type.Boolean()),
			maxSelfReviewCycles: Type.Optional(Type.Number()),
		}),
	], { description: "Planner config: boolean enables/disables, string sets model, object for full config" })),
	coordinator: Type.Optional(Type.Union([
		Type.String(),
		Type.Object({ model: Type.Optional(Type.String()) }),
	], { description: "Coordinator config: string sets model, object for full config" })),
	worker: Type.Optional(Type.Union([
		Type.String(),
		Type.Object({ model: Type.Optional(Type.String()) }),
	], { description: "Worker config: string sets model, object for full config" })),
	reviewer: Type.Optional(Type.Union([
		Type.String(),
		Type.Object({ model: Type.Optional(Type.String()) }),
	], { description: "Reviewer config: string sets model, object for full config" })),
	reviewCycles: Type.Optional(Type.Union([
		Type.Number(),
		Type.Literal(false),
	], { description: "Worker self-review cycles (default: 5, false to disable)" })),
	supervisor: Type.Optional(Type.Union([
		Type.Boolean(),
		Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			nudgeThresholdMs: Type.Optional(Type.Number()),
			restartThresholdMs: Type.Optional(Type.Number()),
			maxRestarts: Type.Optional(Type.Number()),
			checkIntervalMs: Type.Optional(Type.Number()),
		}),
	], { description: "Enable supervisor loop (default: true)" })),
});

type CoordinateParamsType = Static<typeof CoordinateParams>;

interface CoordinationRunOptions {
	runtime: CoordinationRuntime;
	params: CoordinateParamsType;
	onUpdate?: (partial: AgentToolResult<CoordinationDetails>) => void;
	toolCtx?: Pick<ExtensionContext, "hasPendingMessages" | "abort">;
	signal?: AbortSignal;
	coordSessionId?: string;
	sessionDir?: string;
	coordDir?: string;
	traceId?: string;
}

interface CoordinationRunResult {
	result: AgentToolResult<CoordinationDetails>;
	coordDir: string;
	traceId: string;
}

function buildCoordinatorTask(
	planContent: string,
	scoutContext: string,
	agents: string[],
	coordDir: string,
	sharedContextPath?: string,
): string {
	const sharedContextNote = sharedContextPath
		? `### Shared Context File\nUse this file as shared context for workers:\n${sharedContextPath}\n\n`
		: "";
	const filePolicy = `### File IPC Policy (MANDATORY)
Context window is expensive. Filesystem is free.

PROHIBITED:
- Reading file content just to pass it to a subagent (pass the path)
- Reading subagent outputs just to concatenate them (have them write to unique paths, join with bash)
- Materializing large lists in context when a file path suffices

DISPATCH PATTERN (significant I/O):
- Inputs: write lists to \`${path.join(coordDir, "inputs")}/ci_<task>_<i>.txt\` or pass existing file path
- Outputs: ask each worker to write primary results to \`${path.join(coordDir, "outputs")}/<workerId>.md\`
- Shared prompt (>3 sentences): write to \`${sharedContextPath ?? path.join(coordDir, "shared-context.md")}\` and have workers read it\n\n`;

	return `## Coordination Session

You are managing a coordination session. Your job is to spawn worker agents and summarize results.

${sharedContextNote}${filePolicy}${scoutContext ? `
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

const asyncWatchers = new Map<string, fsSync.FSWatcher>();

function resolveAsyncResultsDir(cwd: string, override?: string): string {
	if (!override) return ASYNC_RESULTS_DIR;
	return path.isAbsolute(override) ? override : path.join(cwd, override);
}

function ensureAsyncWatcher(events: EventBus, cwd: string, resultsDir: string): void {
	if (asyncWatchers.has(resultsDir)) return;
	try {
		fsSync.mkdirSync(resultsDir, { recursive: true });
	} catch {}

	const handleResult = (file: string) => {
		const resultPath = path.join(resultsDir, file);
		if (!fsSync.existsSync(resultPath)) return;
		try {
			const data = JSON.parse(fsSync.readFileSync(resultPath, "utf-8"));
			if (data?.cwd && data.cwd !== cwd) return;
			if (data?.parentPid && data.parentPid !== process.pid) return;
			events.emit("coordination:complete", data);
			fsSync.unlinkSync(resultPath);
		} catch {}
	};

	const watcher = fsSync.watch(resultsDir, (eventType, file) => {
		if (eventType === "rename" && file?.toString().endsWith(".json")) {
			setTimeout(() => handleResult(file.toString()), 50);
		}
	});
	asyncWatchers.set(resultsDir, watcher);

	try {
		const now = Date.now();
		for (const file of fsSync.readdirSync(resultsDir).filter((f) => f.endsWith(".json"))) {
			const filePath = path.join(resultsDir, file);
			try {
				const stat = fsSync.statSync(filePath);
				if (now - stat.mtimeMs > ASYNC_STALE_MS) {
					fsSync.unlinkSync(filePath);
				} else {
					handleResult(file);
				}
			} catch {}
		}
	} catch {}
}

export async function runCoordinationSession(options: CoordinationRunOptions): Promise<CoordinationRunResult> {
	const { runtime, params, onUpdate, signal } = options;
	const toolCtx = options.toolCtx ?? {
		hasPendingMessages: () => false,
		abort: () => {},
	};
	const coordSessionId = options.coordSessionId ?? randomUUID();
	const sessionDir = options.sessionDir != null
		? options.sessionDir
		: (process.env.PI_SESSION_DIR || path.join(os.homedir(), ".pi", "sessions", "default"));
	const coordDir = options.coordDir ?? path.join(sessionDir, "coordination", coordSessionId);

	const storage = new FileBasedStorage(coordDir);
	await storage.initialize();
	const sharedContextPath = path.join(coordDir, "shared-context.md");
	const inputsDir = path.join(coordDir, "inputs");
	const outputsDir = path.join(coordDir, "outputs");
	await fs.mkdir(inputsDir, { recursive: true });
	await fs.mkdir(outputsDir, { recursive: true });

	const planPath = path.resolve(runtime.cwd, params.plan);
	const planDir = path.dirname(planPath);
	let planContent: string;
	try {
		planContent = await fs.readFile(planPath, "utf-8");
	} catch (err) {
		return {
			result: {
				content: [{ type: "text", text: `Failed to read plan file: ${planPath}\n${err}` }],
				isError: true,
			},
			coordDir,
			traceId: options.traceId || "",
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

	const coordinatorExtensionPath = path.join(__dirname, "..", "..", "extensions", "coordination", "coordinator.ts");

	const discovery = discoverAgents(runtime.cwd, "user");
	const agents = discovery.agents;

	const coordinatorAgent = agents.find(a => a.name === "coordinator");
	if (!coordinatorAgent) {
		delete process.env.PI_ACTIVE_COORDINATION_DIR;
		delete process.env.PI_COORDINATION_DIR;
		delete process.env.PI_AGENT_IDENTITY;
		return {
			result: {
				content: [{ type: "text", text: "Coordinator agent not found. Create ~/.pi/agent/agents/coordinator.md" }],
				isError: true,
			},
			coordDir,
			traceId: options.traceId || "",
		};
	}

	const augmentedAgents: AgentConfig[] = agents.map(a => {
		if (a.name === "coordinator") {
			return {
				...a,
				tools: [...(a.tools || []), coordinatorExtensionPath],
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
	const settings = loadCoordinationSettings();
	const costLimit = params.costLimit ?? settings.costLimit ?? 40;
	let costState = initializeCostState(costLimit);
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
				result: {
					content: [{ type: "text", text: `Failed to restore from checkpoint: ${params.resume}\n${err}` }],
					isError: true,
				},
				coordDir,
				traceId: options.traceId || "",
			};
		}
	}

	const normalizeAgents = (v: string[] | number | undefined): string[] | undefined =>
		typeof v === "number" ? Array(v).fill("worker") : v;
	const normalizeBoolOrObj = <T extends object>(v: boolean | T | undefined): T | undefined =>
		typeof v === "boolean" ? { enabled: v } as T : v;
	const normalizePhaseConfig = <T extends { model?: string }>(v: string | T | boolean | undefined): T | undefined => {
		if (typeof v === "string") return { model: v } as T;
		if (typeof v === "boolean") return { enabled: v } as T;
		return v;
	};

	const paramScout = normalizePhaseConfig(params.scout);
	const paramPlanner = normalizePhaseConfig(params.planner);
	const paramCoordinator = normalizePhaseConfig(params.coordinator);
	const paramWorker = normalizePhaseConfig(params.worker);
	const paramReviewer = normalizePhaseConfig(params.reviewer);
	const paramSupervisor = normalizeBoolOrObj(params.supervisor);

	const defaultModel = options.defaultModel;
	const models = {
		scout: paramScout?.model || defaultModel,
		planner: (paramPlanner as { model?: string })?.model || defaultModel,
		coordinator: paramCoordinator?.model || defaultModel,
		worker: paramWorker?.model || defaultModel,
		reviewer: paramReviewer?.model || defaultModel,
	};

	const reviewCycles = params.reviewCycles ?? settings.reviewCycles ?? 5;
	const selfReviewConfig = {
		enabled: reviewCycles !== false,
		maxCycles: reviewCycles === false ? 0 : reviewCycles,
	};

	const pipelineConfig: PipelineConfig = {
		planPath,
		planContent,
		planDir,
		coordDir,
		sessionId: coordSessionId,
		agents: normalizeAgents(params.agents) ?? settings.agents ?? ["worker", "worker", "worker", "worker"],
		maxFixCycles: params.maxFixCycles ?? settings.maxFixCycles ?? 3,
		sameIssueLimit: params.sameIssueLimit ?? 2,
		checkTests: params.checkTests ?? settings.checkTests ?? true,
		costLimit,
		maxOutput: params.maxOutput,
		models,
		planner: {
			enabled: (paramPlanner as { enabled?: boolean })?.enabled ?? settings.planner?.enabled ?? true,
			humanCheckpoint: (paramPlanner as { humanCheckpoint?: boolean })?.humanCheckpoint ?? settings.planner?.humanCheckpoint ?? false,
			maxSelfReviewCycles: (paramPlanner as { maxSelfReviewCycles?: number })?.maxSelfReviewCycles ?? settings.planner?.maxSelfReviewCycles ?? 5,
		},
		selfReview: selfReviewConfig,
		supervisor: {
			enabled: paramSupervisor?.enabled ?? settings.supervisor?.enabled ?? true,
			nudgeThresholdMs: paramSupervisor?.nudgeThresholdMs ?? settings.supervisor?.nudgeThresholdMs ?? 180000,
			restartThresholdMs: paramSupervisor?.restartThresholdMs ?? settings.supervisor?.restartThresholdMs ?? 300000,
			maxRestarts: paramSupervisor?.maxRestarts ?? settings.supervisor?.maxRestarts ?? 2,
			checkIntervalMs: paramSupervisor?.checkIntervalMs ?? settings.supervisor?.checkIntervalMs ?? 30000,
		},
	};

	const runtimeConfig = {
		selfReview: pipelineConfig.selfReview,
		supervisor: pipelineConfig.supervisor,
		models: pipelineConfig.models,
	};
	await fs.writeFile(
		path.join(coordDir, "runtime-config.json"),
		JSON.stringify(runtimeConfig, null, 2),
	);

	const obs = await ObservabilityContext.create(
		coordDir,
		runtime.cwd,
		"coordinator",
		"system",
		options.traceId,
	);

	process.env.PI_TRACE_ID = obs.getTraceId();

	await obs.events.emit({
		type: "session_started",
		config: {
			planPath,
			agents: params.agents,
			maxFixCycles: params.maxFixCycles ?? 3,
			sameIssueLimit: params.sameIssueLimit ?? 2,
			costLimit,
		},
	});

	let streamingValidator: StreamingValidator | null = null;
	let unsubscribeStreaming: (() => void) | null = null;

	if (params.validateStream) {
		streamingValidator = createStreamingValidator(
			(invariant, message) => {
				if (!toolCtx.hasPendingMessages()) {
					console.warn(`[VALIDATION WARNING] ${invariant}: ${message}`);
				}
			},
			(invariant, message) => {
				if (!toolCtx.hasPendingMessages()) {
					console.error(`[VALIDATION ERROR] ${invariant}: ${message}`);
				}
			},
		);
		unsubscribeStreaming = obs.events.subscribe((event) => {
			streamingValidator?.onEvent(event);
		});
		streamingValidator.start();
	}

	const pipelineContext: PipelineContext = {
		runtime,
		storage,
		checkpointManager,
		pipelineState,
		costState,
		reviewHistory,
		signal,
		onUpdate,
		obs,
		abort: () => toolCtx.abort(),
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
			toolCount: w.toolCount,
			tokens: w.tokens,
			durationMs: w.durationMs,
			recentTools: w.recentTools,
			lastOutput: w.lastOutput,
			artifactsDir: w.artifactsDir,
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
			pipeline: {
				currentPhase: pipelineState.currentPhase,
				phases: pipelineState.phases,
				fixCycle: pipelineState.fixCycle,
			},
			cost: costState,
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
					details: makeCoordDetails(result, state, workerStates, events, normalizeAgents(params.agents)),
				});
			}).catch(() => {
				onUpdate({
					content: [{ type: "text", text: "working..." }],
					details: makeCoordDetails(result, undefined, undefined, undefined, normalizeAgents(params.agents)),
				});
			});
		}
	} : undefined;

	let lastProgressEmit = 0;
	const emitProgress = (state: CoordinationState, workerStates: WorkerStateFile[]) => {
		const now = Date.now();
		if (now - lastProgressEmit < PROGRESS_EMIT_INTERVAL_MS) return;
		lastProgressEmit = now;

		const counts = {
			total: workerStates.length,
			completed: workerStates.filter((w) => w.status === "complete").length,
			failed: workerStates.filter((w) => w.status === "failed").length,
			working: workerStates.filter((w) => w.status === "working").length,
			waiting: workerStates.filter((w) => w.status === "waiting").length,
			blocked: workerStates.filter((w) => w.status === "blocked").length,
			pending: workerStates.filter((w) => w.status === "pending").length,
		};

		runtime.events.emit("coordination:progress", {
			sessionId: coordSessionId,
			coordDir,
			phase: pipelineState.currentPhase,
			status: state.status,
			counts,
			workers: workerStates.map((w) => ({
				id: w.id,
				shortId: w.shortId,
				status: w.status,
				currentTool: w.currentTool,
				toolCount: w.toolCount,
				tokens: w.tokens,
				durationMs: w.durationMs,
			})),
			cost: { total: workerStates.reduce((sum, w) => sum + w.usage.cost, 0) },
			timestamp: now,
		});
	};

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

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: "coordinating..." }],
					details: makeCoordDetails(lastCoordResult, state, workerStates, events, normalizeAgents(params.agents)),
				});
			}
			emitProgress(state, workerStates);
		} catch {}
	}, 200);

	try {
		let coordExitError = false;
		let coordinatorResult: SingleResult = lastCoordResult;

		const shouldRunPhase = (phase: PipelinePhase): boolean => {
			if (!resumeFromPhase) return true;
			const phaseOrder: PipelinePhase[] = ["scout", "planner", "coordinator", "workers", "review", "fixes", "complete"];
			const resumeIdx = phaseOrder.indexOf(resumeFromPhase);
			const phaseIdx = phaseOrder.indexOf(phase);
			return phaseIdx >= resumeIdx;
		};

		if (shouldRunPhase("scout")) {
			await runScoutPhaseWrapper(pipelineContext, pipelineConfig);
		}

		if (pipelineConfig.planner?.enabled) {
			await runPlannerPhaseWrapper(pipelineContext, pipelineConfig);
		}

		const scoutContext = pipelineState.scoutContext || "";
		let sharedContextReady = false;
		try {
			await writeSharedContextFile(sharedContextPath, planContent, scoutContext);
			sharedContextReady = true;
			process.env.PI_COORDINATION_SHARED_CONTEXT = sharedContextPath;
		} catch {}

		if (shouldRunPhase("coordinator")) {
			const coordSpan = obs.spans.startSpan("phase:coordinator", "phase");
			await obs.snapshots.capture("phase_start", "coordinator");

			const task = buildCoordinatorTask(
				planContent,
				scoutContext,
				params.agents,
				coordDir,
				sharedContextReady ? sharedContextPath : undefined,
			);

			updatePhaseStatus("coordinator", "running", pipelineContext);
			const coordAgents = pipelineConfig.models?.coordinator
				? augmentedAgents.map(a => a.name === "coordinator" ? { ...a, model: pipelineConfig.models!.coordinator } : a)
				: augmentedAgents;
			coordinatorResult = await runSingleAgent(
				runtime,
				coordAgents,
				"coordinator",
				task,
				planDir,
				undefined,
				signal,
				coordOnUpdate,
				makeDetails,
				{
					outputLimits: pipelineConfig.maxOutput,
					artifactsDir: path.join(coordDir, "artifacts"),
					artifactLabel: "coordinator",
				},
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
			...makeCoordDetails(coordinatorResult, finalState, workerStates, events, normalizeAgents(params.agents)),
			pipeline: {
				currentPhase: pipelineState.currentPhase,
				phases: pipelineState.phases,
				fixCycle: pipelineState.fixCycle,
			},
			cost: costState,
		};

		const isError = coordExitError || pipelineState.exitReason === "cost_limit" || pipelineState.exitReason === "stuck";

		let summary: string;
		if (pipelineState.exitReason === "clean") {
			summary = "Coordination completed successfully - all review checks passed";
		} else if (pipelineState.exitReason === "stuck") {
			summary = `Coordination completed with unresolved issues after ${pipelineState.fixCycle} fix cycles`;
		} else if (pipelineState.exitReason === "max_cycles") {
			summary = `Coordination completed - max fix cycles (${pipelineState.maxFixCycles}) reached`;
		} else if (pipelineState.exitReason === "cost_limit") {
			summary = `Coordination ended - cost limit reached ($${costState.total.toFixed(2)} / $${costState.limit.toFixed(2)})`;
		} else {
			summary = getResultOutput(coordinatorResult) ||
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
					? path.resolve(runtime.cwd, params.logPath)
					: process.env.PI_COORDINATION_LOG_DIR
						? path.resolve(process.env.PI_COORDINATION_LOG_DIR)
						: runtime.cwd;
				
				const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				const logFileName = `coordination-log-${timestamp}.md`;
				logFilePath = path.join(logDir, logFileName);

				await fs.mkdir(logDir, { recursive: true });
				await fs.writeFile(logFilePath, logContent, "utf-8");
			} catch (logErr) {
				console.error(`Failed to write coordination log: ${logErr}`);
			}
		}

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

		let validationResult: ValidationResult | undefined;
		if (params.validate) {
			validationResult = await validateCoordination({
				coordDir,
				planPath,
				planContent,
				mode: "post-hoc",
				strictness: "warn-soft-fatal-hard",
				checkContent: true,
			});

			detailsWithPipeline.validation = validationResult;

			if (validationResult.reportPath) {
				summary = `${summary}\n\nValidation: ${validationResult.passed ? "PASSED" : "FAILED"}\nReport: ${validationResult.reportPath}`;
			}
		}

		const finalSummary = logFilePath
			? `${summary}\n\nLog saved to: ${logFilePath}`
			: summary;

		return {
			result: {
				content: [{ type: "text", text: finalSummary }],
				details: detailsWithPipeline,
				isError: isError || (validationResult ? !validationResult.passed : false),
			},
			coordDir,
			traceId: obs.getTraceId(),
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
			result: {
				content: [{ type: "text", text: `Coordination failed: ${err}` }],
				isError: true,
			},
			coordDir,
			traceId: obs.getTraceId(),
		};
	} finally {
		if (statusInterval) {
			clearInterval(statusInterval);
		}
		if (streamingValidator) {
			streamingValidator.stop();
		}
		if (unsubscribeStreaming) {
			unsubscribeStreaming();
		}
		if (pipelineContext.plannerBackgroundAbort) {
			pipelineContext.plannerBackgroundAbort.abort();
		}
		delete process.env.PI_ACTIVE_COORDINATION_DIR;
		delete process.env.PI_COORDINATION_DIR;
		delete process.env.PI_AGENT_IDENTITY;
		delete process.env.PI_COORDINATION_SHARED_CONTEXT;
		delete process.env.PI_TRACE_ID;
	}
}

export function createCoordinateTool(events: EventBus): ToolDefinition<typeof CoordinateParams, CoordinationDetails> {
	const tool: ToolDefinition<typeof CoordinateParams, CoordinationDetails> = {
		name: "coordinate",
		label: "Coordinate",
		description:
			"Start multi-agent coordination session. Splits a plan across parallel workers, manages dependencies, and returns unified results. Saves a markdown log to the project directory (configurable via logPath parameter or PI_COORDINATION_LOG_DIR env var).",
		parameters: CoordinateParams,

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			const typedParams = params as CoordinateParamsType;
			const resultsDir = resolveAsyncResultsDir(ctx.cwd, typedParams.asyncResultsDir);

			if (typedParams.async) {
				if (!jitiCliPath) {
					return {
						content: [{ type: "text", text: "Async coordination requires jiti (not found)." }],
						isError: true,
					};
				}
				ensureAsyncWatcher(events, ctx.cwd, resultsDir);

				const coordSessionId = randomUUID();
				const sessionDir = process.env.PI_SESSION_DIR || path.join(os.homedir(), ".pi", "sessions", "default");
				const coordDir = path.join(sessionDir, "coordination", coordSessionId);
				const planPath = path.resolve(ctx.cwd, typedParams.plan);

				try {
					await fs.access(planPath);
				} catch (err) {
					return {
						content: [{ type: "text", text: `Failed to read plan file: ${planPath}\n${err}` }],
						isError: true,
					};
				}

				const asyncId = randomUUID();
				const runnerPath = path.join(__dirname, "async-runner.ts");
				const resultPath = path.join(resultsDir, `${asyncId}.json`);
				const cfgPath = path.join(os.tmpdir(), `pi-async-coordination-${asyncId}.json`);

				const runnerConfig = {
					asyncId,
					coordSessionId,
					coordDir,
					planPath,
					params: { ...typedParams, async: false, asyncResultsDir: undefined },
					cwd: ctx.cwd,
					resultPath,
					sessionDir,
					parentPid: process.pid,
				};

				try {
					await fs.mkdir(resultsDir, { recursive: true });
				} catch {}
				await fs.writeFile(cfgPath, JSON.stringify(runnerConfig), "utf-8");

				const proc = spawn("node", [jitiCliPath, runnerPath, cfgPath], {
					cwd: ctx.cwd,
					detached: true,
					stdio: "ignore",
					env: process.env,
				});
				proc.unref();

				const placeholder: SingleResult = {
					agent: "coordinator",
					agentSource: "user",
					task: "",
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				};

				return {
					content: [{ type: "text", text: `Async coordination started [${asyncId}]` }],
					details: {
						sessionId: coordSessionId,
						coordDir,
						status: "analyzing",
						coordinatorResult: placeholder,
						workers: [],
						events: [],
						pendingAgents: typedParams.agents,
						deviations: [],
						startedAt: Date.now(),
						async: {
							id: asyncId,
							status: "queued",
							resultPath,
							resultsDir,
							coordDir,
						},
					},
				};
			}

			const { result } = await runCoordinationSession({
				runtime: { cwd: ctx.cwd, events },
				params: typedParams,
				onUpdate,
				toolCtx: {
					hasPendingMessages: () => ctx.hasPendingMessages(),
					abort: () => ctx.abort(),
				},
				signal,
			});
			return result;
		},

		renderCall(args, theme) {
			const planPath = args.plan || "...";
			const agentCount = args.agents?.length || 0;
			const asyncLabel = args.async ? theme.fg("warning", " [async]") : "";
			let text = theme.fg("toolTitle", theme.bold("coordinate ")) +
				theme.fg("accent", planPath) +
				theme.fg("muted", ` (${agentCount} agents)`) +
				asyncLabel;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const { details } = result;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			if (details.async?.status === "queued") {
				const msg = `ASYNC QUEUED [${details.async.id}]`;
				const info = `Result: ${details.async.resultPath}`;
				return new Text(`${theme.fg("warning", msg)}\n${theme.fg("dim", info)}`, 0, 0);
			}

			const container = new Container();
			const isError = result.isError;
			const icon = isError ? theme.fg("error", "x") : theme.fg("success", "ok");
			const workers = details.workers || [];
			const events = details.events || [];
			const allDone = workers.length > 0 &&
				workers.every(w => w.status === "complete" || w.status === "failed");

			if (details.pipeline) {
				const phases: PipelinePhase[] = ["scout", "planner", "coordinator", "workers", "review", "fixes", "complete"];
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
						`Cost: $${details.cost.total.toFixed(2)} / $${details.cost.limit.toFixed(2)} limit`,
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

				const output = details.coordinatorResult ? getResultOutput(details.coordinatorResult) : "";
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
					if (ev.type === "cost_milestone" || ev.type === "cost_limit_reached") {
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
						case "cost_limit_reached":
							line += theme.fg("warning", `cost limit reached: $${(ev as { total: number }).total.toFixed(2)}`);
							break;
					}

					container.addChild(new Text(line, 0, 0));
				}
			}

			return container;
		},
	};

	return tool;
}
