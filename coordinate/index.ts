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
import {
	ICONS,
	getSpinnerFrame,
	getStatusIcon,
	getStatusColor,
	formatDuration,
	formatCost,
	formatContextUsage,
	renderPipelineRow,
	renderCostBreakdown,
	renderWorkersCompact,
	renderTasksCentric,
	renderFileReservations,
	renderTasksCompact,
	renderTaskProgress,
	renderEventLine,
	renderQuestionBuffer,
	renderCoordinationDashboard,
	drawBoxTop,
	drawBoxBottom,
	drawBoxLine,
	workerStateToDisplay,
	generateMemorableName,
	type PipelineDisplayState,
	type WorkerDisplayState,
	type TaskDisplayState,
	type TaskProgress,
	type TaskCentricEntry,
} from "./render-utils.js";

interface CoordinationSettings {
	agents?: string[] | number;
	reviewCycles?: number | false;
	supervisor?: boolean | { enabled?: boolean; nudgeThresholdMs?: number; restartThresholdMs?: number; maxRestarts?: number; checkIntervalMs?: number };
	costLimit?: number;
	maxFixCycles?: number;
	checkTests?: boolean;
}

interface NormalizedSettings {
	agents?: string[];
	reviewCycles?: number | false;
	supervisor?: { enabled?: boolean; nudgeThresholdMs?: number; restartThresholdMs?: number; maxRestarts?: number; checkIntervalMs?: number };
	costLimit?: number;
	maxFixCycles?: number;
	checkTests?: boolean;
}

function normalizeSettings(raw: CoordinationSettings): NormalizedSettings {
	return {
		agents: typeof raw.agents === "number" ? Array(raw.agents).fill("worker") : raw.agents,
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
import { AuditLog } from "./audit-log.js";
import { generateCoordinationLog } from "./log-generator.js";
import { CheckpointManager } from "./checkpoint.js";
import {
	compactSession,
	loadCrossSessionDigest,
	buildWorkerContextHeader,
	type CompletedTask,
	type SessionDigest,
} from "./context-compactor.js";
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
import type { CoordinationState, CoordinationEvent, WorkerStateFile, WorkerStatus, CoordinationStatus, PipelinePhase, PhaseResult, CostState, FileReservation, Task } from "./types.js";
import type { ReviewResult } from "./phases/review.js";
import { ObservabilityContext } from "./observability/index.js";
import { validateCoordination } from "./validation/index.js";
import type { ValidationResult } from "./validation/types.js";
import { createStreamingValidator, type StreamingValidator } from "./validation/streaming.js";
// Note: question-generator.ts and inline-questions-tui.ts are kept for the plan tool
// import { generateClarifyingQuestions } from "./question-generator.js";
// import { runInlineQuestionsTUI, type Answer } from "./inline-questions-tui.js";
import { parseSpec } from "./spec-parser.js";
import { validateSpec, formatValidationResult } from "./spec-validator.js";
import {
	loadProgressSnapshot,
	deleteProgressSnapshot,
	findResumeCoordDir,
} from "./progress-tracker.js";
import {
	enrichTaskWithQAFailures,
	autoResolveFailuresForSession,
	getQALoopSummary,
} from "./qa-feedback.js";
import { TaskQueueManager } from "./task-queue.js";
import { checkGate, type HITLMode } from "./hitl-gate.js";
import type { SpecTask } from "./spec-parser.js";
import {
	shouldUseWorktrees,
	registerWorktreeCleanupHandlers,
} from "./worktree-manager.js";

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

/**
 * Read task progress from tasks.json
 */
async function readTaskProgress(coordDir: string): Promise<TaskProgress | null> {
	try {
		const tasksPath = path.join(coordDir, "tasks.json");
		const content = await fs.readFile(tasksPath, "utf-8");
		const queue = JSON.parse(content);
		const tasks = queue.tasks || [];
		
		return {
			total: tasks.length,
			completed: tasks.filter((t: any) => t.status === "complete").length,
			active: tasks.filter((t: any) => t.status === "claimed").length,
			// Include pending_review in pending count (discovered tasks awaiting approval)
			pending: tasks.filter((t: any) => t.status === "pending" || t.status === "pending_review").length,
			blocked: tasks.filter((t: any) => t.status === "blocked").length,
			failed: tasks.filter((t: any) => t.status === "failed").length,
		};
	} catch {
		return null;
	}
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
	usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: number; turns: number };
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
	planPath?: string;
	pipeline?: {
		currentPhase: PipelinePhase;
		phases: Record<PipelinePhase, PhaseResult>;
		fixCycle: number;
	};
	cost?: CostState;
	reservations?: FileReservation[];
	taskProgress?: TaskProgress;
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
	plan: Type.String({ description: "Path to TASK-XX format spec file. Use 'plan' tool first to create specs from prose/PRDs." }),
	hitl: Type.Optional(Type.Union([
		Type.Literal("strict"),
		Type.Literal("permissive"),
		Type.Literal("off"),
	], { description: "HITL (Human-in-the-Loop) permission gate mode. 'strict' = require approval for critical AND high severity actions. 'permissive' = require approval for critical-only actions. 'off' = disabled (default: 'permissive')" })),
	agents: Type.Optional(Type.Union([
		Type.Array(Type.String()),
		Type.Number(),
	], { description: "Worker agents: array of names or count (default: 4 workers)" })),
	logPath: Type.Optional(Type.String({ description: "Path for coordination log output. Defaults to cwd. Set to empty string to disable." })),
	background: Type.Optional(Type.Boolean({ description: "If true, detach the coordination run so you can close the terminal and come back to results. Returns immediately with a run ID. Poll status with scripts/pi-status.sh or getRunStatus()." })),
	resume: Type.Optional(Type.Union([
		Type.Boolean({ description: "true = resume from last checkpoint for this spec (task-level resume)" }),
		Type.String({ description: "Checkpoint ID to resume from (phase-level pipeline checkpoint)" }),
	], { description: "Resume from checkpoint: pass true for task-level resume (skip already-completed tasks) or a checkpoint ID string for phase-level resume" })),
	maxFixCycles: Type.Optional(Type.Number({ description: "Maximum review/fix cycles (default: 5)" })),
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
	useWorktrees: Type.Optional(Type.Boolean({ description: "Give each parallel worker an isolated git worktree (default: auto-detect)" })),
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
	defaultModel?: string;
}

interface CoordinationRunResult {
	result: AgentToolResult<CoordinationDetails>;
	coordDir: string;
	traceId: string;
}

/**
 * Convert parsed spec tasks to Task queue entries, optionally pre-marking
 * already-completed tasks so they are skipped by spawn_from_queue workers.
 */
function specTasksToQueueEntries(
	specTasks: SpecTask[],
	planPath: string,
	planHash: string,
	completedIds: ReadonlySet<string>,
	failedIds: ReadonlySet<string>,
): Task[] {
	const priorityMap: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
	return specTasks.map((st): Task => ({
		id: st.id,
		description: [
			`## ${st.title || st.id}`,
			st.description || "",
			st.acceptance ? `**Acceptance:** ${st.acceptance}` : "",
		].filter(Boolean).join("\n\n"),
		priority: priorityMap[st.priority] ?? 2,
		priorityLabel: st.priority,
		status: completedIds.has(st.id) ? "complete" : failedIds.has(st.id) ? "failed" : "pending",
		files: st.files.map((f) => f.path),
		dependsOn: st.dependsOn,
		acceptanceCriteria: st.acceptance ? [st.acceptance] : [],
		parentTaskId: st.parentTaskId,
	}));
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
   - Workers will use agent_sync({ action: 'need', item: '...' }) to block until dependencies are ready
   - Workers will use agent_sync({ action: 'provide', item: '...' }) when they finish producing the dependency

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
      "handshakeSpec": "Create src/types.ts with User interface (id: string, name: string). After creating the file, call agent_sync({ action: 'provide', item: 'User type', file: 'src/types.ts' })."
    },
    {
      "agent": "worker",
      "logicalName": "worker-B",
      "steps": [2],
      "adjacentWorkers": ["worker-A"],
      "handshakeSpec": "First call agent_sync({ action: 'need', item: 'User type' }) to wait for the User type to be ready. Then create src/service.ts with createUser function that imports User from ./types."
    },
    {
      "agent": "worker",
      "logicalName": "worker-C",
      "steps": [3],
      "adjacentWorkers": ["worker-A"],
      "handshakeSpec": "First call agent_sync({ action: 'need', item: 'User type' }) to wait for the User type to be ready. Then create src/validator.ts with validateUser function that imports User from ./types."
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
- For providers: include "call agent_sync({ action: 'provide', item: 'X' }) when done"
- For waiters: include "call agent_sync({ action: 'need', item: 'X' }) before starting work"`;
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
		const filename = path.basename(planPath);
		const suggestions = [
			path.join(path.dirname(planDir), filename),
			path.join(planDir, "specs", filename),
			path.join(planDir, filename.replace(/\.md$/, "") + ".md"),
		];
		const found = suggestions.find(s => fsSync.existsSync(s));
		const hint = found
			? `\n  Did you mean: ${found}`
			: `\n  Run: ls ${planDir}/ to see available files`;
		return {
			result: {
				content: [{ type: "text", text: `Plan file not found: ${planPath}${hint}\n\nOriginal error: ${err}` }],
				isError: true,
			},
			coordDir,
			traceId: options.traceId || "",
		};
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Spec Validation: Validate TASK-XX format
	// ─────────────────────────────────────────────────────────────────────────
	// Parse and validate the spec format
	const parsedSpec = parseSpec(planContent, planPath);
	const specValidation = validateSpec(parsedSpec);

	// ─────────────────────────────────────────────────────────────────────────
	// Spec Validation: Require valid TASK-XX format
	// ─────────────────────────────────────────────────────────────────────────
	if (!specValidation.valid) {
		// Spec validation failed - return helpful error
		const errorReport = formatValidationResult(specValidation);
		const hasNoTasks = specValidation.errors.some(e => e.code === "NO_TASKS");
		// Detect prose PRD: has markdown headers but no TASK-XX format
		const looksLikeProsePrd = hasNoTasks && /^#{1,3} /m.test(planContent) && !/^## TASK-\d+/m.test(planContent);
		const noTasksHint = looksLikeProsePrd
			? `\n\nThis file looks like a prose PRD (has headers but no TASK-XX sections).\nConvert it to a spec first:\n  plan({ input: "${planPath}" })`
			: "";
		return {
			result: {
				content: [{
					type: "text",
					text: `Invalid spec format. The coordinate tool requires a valid TASK-XX format spec.

${errorReport}${noTasksHint}

To create a valid spec, use the 'plan' tool:
  plan({ input: "${planPath}" })

Or fix the spec file to include TASK-XX format tasks:

## TASK-01: [Title]
Priority: P1
Files: src/file.ts (create)
Depends on: none
Acceptance: [testable criteria]

See: pi-coordination README for spec format documentation.`,
				}],
				isError: true,
			},
			coordDir,
			traceId: options.traceId || "",
		};
	}

	// Log validation info
	console.log(`[spec-validation] Valid spec: ${parsedSpec.tasks.length} tasks`);
	if (specValidation.warnings.length > 0) {
		console.log(`[spec-validation] Warnings: ${specValidation.warnings.map(w => w.message).join("; ")}`);
	}

	// Two-track architecture: coordinate always runs on valid specs
	// ── Context Compaction: load prior session digest (cross-session memory) ──
	const planSpecHash = hash(planContent);
	let priorSessionDigest: SessionDigest | null = null;
	try {
		priorSessionDigest = await loadCrossSessionDigest(planSpecHash);
		if (priorSessionDigest) {
			console.log(`[context] Loading prior session digest from ${priorSessionDigest.createdAt} (phase: ${priorSessionDigest.phase})`);
		}
	} catch {
		// Non-fatal: cross-session memory is best-effort
	}

	console.log(`[coordinate] Starting execution with ${parsedSpec.tasks.length} tasks`);

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

	const coordinatorExtensionPath = path.join(__dirname, "..", "coordinator.ts");

	const discovery = discoverAgents(runtime.cwd, "user");
	const agents = discovery.agents;

	const coordinatorAgent = agents.find(a => a.name === "coordination/coordinator");
	if (!coordinatorAgent) {
		delete process.env.PI_ACTIVE_COORDINATION_DIR;
		delete process.env.PI_COORDINATION_DIR;
		delete process.env.PI_AGENT_IDENTITY;
		return {
			result: {
				content: [{ type: "text", text: "Coordinator agent not found. Create ~/.pi/agent/agents/coordination/coordinator.md" }],
				isError: true,
			},
			coordDir,
			traceId: options.traceId || "",
		};
	}

	const augmentedAgents: AgentConfig[] = agents.map(a => {
		if (a.name === "coordination/coordinator") {
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
		params.maxFixCycles ?? 5,
	);
	const settings = loadCoordinationSettings();
	const costLimit = params.costLimit ?? settings.costLimit ?? 40;
	let costState = initializeCostState(costLimit);
	let reviewHistory: ReviewResult[] = [];
	let resumeFromPhase: PipelinePhase | null = null;

	if (params.resume && typeof params.resume === "string") {
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
		typeof v === "boolean" ? ({ enabled: v } as unknown as T) : v;
	const normalizePhaseConfig = <T extends { model?: string }>(v: string | T | boolean | undefined): T | undefined => {
		if (typeof v === "string") return { model: v } as T;
		if (typeof v === "boolean") return { enabled: v } as T;
		return v;
	};

	const paramCoordinator = normalizePhaseConfig(params.coordinator);
	const paramWorker = normalizePhaseConfig(params.worker);
	const paramReviewer = normalizePhaseConfig(params.reviewer);
	const paramSupervisor = normalizeBoolOrObj(params.supervisor);

	const defaultModel = options.defaultModel;
	// Helper to get agent's frontmatter model
	const getAgentModel = (name: string): string | undefined => 
		agents.find(a => a.name === name)?.model;
	
	// Model resolution: param > agent frontmatter > pi's defaultModel
	// Note: scout and planner are omitted - those phases are now in plan tool
	const models = {
		coordinator: paramCoordinator?.model || getAgentModel("coordination/coordinator") || defaultModel,
		worker: paramWorker?.model || getAgentModel("coordination/worker") || defaultModel,
		reviewer: paramReviewer?.model || getAgentModel("coordination/reviewer") || defaultModel,
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
		maxFixCycles: params.maxFixCycles ?? settings.maxFixCycles ?? 5,
		sameIssueLimit: params.sameIssueLimit ?? 2,
		checkTests: params.checkTests ?? settings.checkTests ?? true,
		costLimit,
		maxOutput: params.maxOutput,
		models,
		skipScout: true, // Two-track: scout phase is now in plan tool
		planner: {
			// Two-track: planner phase is now in plan tool, always disabled in coordinate
			enabled: false,
			humanCheckpoint: false,
			maxSelfReviewCycles: 0,
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

	const workerCount = (normalizeAgents(params.agents) ?? settings.agents ?? ["worker", "worker", "worker", "worker"]).length;
	const enableWorktrees = params.useWorktrees !== undefined
		? params.useWorktrees
		: await shouldUseWorktrees(runtime.cwd, workerCount);

	const runtimeConfig = {
		selfReview: pipelineConfig.selfReview,
		supervisor: pipelineConfig.supervisor,
		models: pipelineConfig.models,
		useWorktrees: enableWorktrees,
		repoRoot: runtime.cwd,
	};
	await fs.writeFile(
		path.join(coordDir, "runtime-config.json"),
		JSON.stringify(runtimeConfig, null, 2),
	);

	if (enableWorktrees) {
		registerWorktreeCleanupHandlers(runtime.cwd, coordSessionId);
		console.log(`[worktrees] Isolation enabled — each worker gets its own git worktree`);
	}

	// Save execution info
	const executionInfo = {
		mode: "spec" as const,  // Always spec mode with two-track architecture
		skipScout: true,        // Scout is now in plan tool
		skipPlanner: true,      // Planner is now in plan tool
		taskCount: parsedSpec.tasks.length,
		timestamp: Date.now(),
	};
	await fs.writeFile(
		path.join(coordDir, "execution-info.json"),
		JSON.stringify(executionInfo, null, 2),
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
			maxFixCycles: params.maxFixCycles ?? 5,
			sameIssueLimit: params.sameIssueLimit ?? 2,
			costLimit,
			taskCount: parsedSpec.tasks.length,
		},
	});

	// ── Audit log ─────────────────────────────────────────────────────────────
	// Tamper-evident, append-only JSONL log with SHA256 hash chain.
	// Required for EU AI Act traceability and SOC2 compliance.
	const auditLog = new AuditLog(coordDir, coordSessionId);
	auditLog.append({ type: "session.start", sessionId: coordSessionId, agentRole: "coordinator" });

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
		onUpdate: onUpdate as ((partial: AgentToolResult<unknown>) => void) | undefined,
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
		pendingAgents?: string[],
		reservations?: FileReservation[],
		taskProgress?: TaskProgress | null,
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
			planPath,
			pipeline: {
				currentPhase: pipelineState.currentPhase,
				phases: pipelineState.phases,
				fixCycle: pipelineState.fixCycle,
			},
			cost: costState,
			reservations: reservations || [],
			taskProgress: taskProgress || undefined,
		};
	};

	let statusInterval: NodeJS.Timeout | null = null;
	let lastCoordResult: SingleResult = { agent: "coordinator", agentSource: "user", task: "", exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
	let lastMilestoneThreshold = 0;

	let lastCoordToolEndMs = 0; // Dedup coordinator tool events
	const coordOnUpdate: typeof onUpdate = onUpdate ? (partial) => {
		const result = (partial.details as any)?.results?.[0];
		if (result) {
			lastCoordResult = result;
			
			// Emit coordinator tool calls to event stream (deduped)
			const recentTools = result.recentTools;
			if (recentTools && recentTools.length > 0) {
				const latest = recentTools[0];
				if (latest.endMs && latest.endMs !== lastCoordToolEndMs) {
					lastCoordToolEndMs = latest.endMs;
					storage.appendEvent({
						type: "tool_call",
						tool: latest.tool,
						file: latest.args,
						workerId: "coordinator",
						contextTokens: result.usage?.contextTokens,
						timestamp: Date.now(),
					}).catch(() => {});
				}
			}
			
			storage.getState().then(async state => {
				const workerStates = await storage.listWorkerStates();
				const events = await storage.getEvents();
				const reservations = await storage.getActiveReservations();
				onUpdate({
					content: [{ type: "text", text: "coordinating..." }],
					details: makeCoordDetails(result, state, workerStates, events, normalizeAgents(params.agents), reservations),
				});
			}).catch(() => {
				onUpdate({
					content: [{ type: "text", text: "working..." }],
					details: makeCoordDetails(result, undefined, undefined, undefined, normalizeAgents(params.agents), []),
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
			const reservations = await storage.getActiveReservations();
			const taskProgress = await readTaskProgress(coordDir);

			// Update costState with real-time worker costs
			const workerCost = workerStates.reduce((sum, w) => sum + w.usage.cost, 0);
			costState.byPhase.workers = workerCost;
			// Update byWorker tracking
			for (const w of workerStates) {
				costState.byWorker[w.id] = w.usage.cost;
			}
			// Calculate total from all phases (scout, planner may have run earlier)
			costState.total = Object.values(costState.byPhase).reduce((sum, v) => sum + v, 0);

			const currentMilestone = Math.floor(workerCost / 0.25) * 0.25;
			if (currentMilestone > lastMilestoneThreshold && currentMilestone > 0) {
				lastMilestoneThreshold = currentMilestone;
				await storage.appendEvent({
					type: "cost_milestone",
					threshold: currentMilestone,
					totals: Object.fromEntries(workerStates.map(w => [w.id, w.usage.cost])),
					aggregate: workerCost,
					timestamp: Date.now(),
				});
			}

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: "coordinating..." }],
					details: makeCoordDetails(lastCoordResult, state, workerStates, events, normalizeAgents(params.agents), reservations, taskProgress),
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
			const phaseOrder: PipelinePhase[] = ["scout", "planner", "coordinator", "workers", "integration", "review", "fixes", "complete"];
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
			// If we have a prior session digest, include its context header in the shared context
			const priorContextHeader = priorSessionDigest
				? buildWorkerContextHeader(priorSessionDigest)
				: "";
			const augmentedScoutContext = priorContextHeader
				? `${priorContextHeader}\n${scoutContext}`.trim()
				: scoutContext;
			await writeSharedContextFile(sharedContextPath, planContent, augmentedScoutContext);
			sharedContextReady = true;
			process.env.PI_COORDINATION_SHARED_CONTEXT = sharedContextPath;
		} catch {}

		// ─────────────────────────────────────────────────────────────────────
		// Seed tasks.json from spec tasks before the coordinator phase.
		// This ensures spawn_from_queue can work and enables progress tracking.
		// When resume: true, completed tasks are pre-marked so workers skip them.
		// ─────────────────────────────────────────────────────────────────────
		{
			const completedIds = new Set<string>();
			const failedIds = new Set<string>();

			if (params.resume === true) {
				const progressSnapshot = await loadProgressSnapshot(coordDir, hash(planContent));
				if (progressSnapshot && progressSnapshot.completedTasks.length > 0) {
					for (const id of progressSnapshot.completedTasks) completedIds.add(id);
					for (const id of (progressSnapshot.failedTasks ?? [])) failedIds.add(id);
					const skippedList = progressSnapshot.completedTasks.join(", ");
					console.log(`[resume] Skipping ${skippedList} (already complete) — resuming from checkpoint`);
				} else {
					console.log("[resume] No matching checkpoint found — starting fresh");
				}
			}

			const specTaskEntries = specTasksToQueueEntries(
				parsedSpec.tasks,
				planPath,
				hash(planContent),
				completedIds,
				failedIds,
			);

			// ── QA Feedback Loop: enrich task descriptions with known failures ──
			const enrichedEntries = await Promise.all(
				specTaskEntries.map(async (task) => {
					const enrichedDescription = await enrichTaskWithQAFailures(
						task.description,
						task.files ?? [],
					);
					return { ...task, description: enrichedDescription };
				}),
			);

			const taskQueueManager = new TaskQueueManager(coordDir);
			await taskQueueManager.createFromPlan(planPath, hash(planContent), enrichedEntries);

			// ── HITL Gate: scan tasks for high-stakes patterns before dispatch ──
			const hitlMode: HITLMode = (params.hitl as HITLMode) ?? "permissive";
			if (hitlMode !== "off") {
				const heldTaskIds: string[] = [];
				for (const task of enrichedEntries) {
					const gateResult = await checkGate(
						task.id,
						"coordinator",
						task.description,
						coordDir,
						hitlMode,
					);
					if (gateResult.held) {
						heldTaskIds.push(task.id);
					}
				}
				if (heldTaskIds.length > 0) {
					const bar = "═".repeat(62);
					console.log(`\n╔${bar}╗`);
					console.log(`║  ⛔ HITL gates triggered for ${heldTaskIds.length} task(s) — awaiting approval  ║`);
					console.log(`╚${bar}╝`);
					for (const id of heldTaskIds) {
						const gateFile = path.join(coordDir, `hitl-gate-${id}.json`);
						console.log(`  ${id}  gate file: ${gateFile}`);
					}
					console.log(`\n  HITL mode: ${hitlMode} | Approve or reject in gate files above\n`);
				}
			}
		}

		if (shouldRunPhase("coordinator")) {
			const coordSpan = obs.spans.startSpan("phase:coordinator", "phase");
			await obs.snapshots.capture("phase_start", "coordinator");

			const task = buildCoordinatorTask(
				planContent,
				scoutContext,
				pipelineConfig.agents,
				coordDir,
				sharedContextReady ? sharedContextPath : undefined,
			);

			updatePhaseStatus("coordinator", "running", pipelineContext);
			const coordAgents = pipelineConfig.models?.coordinator
				? augmentedAgents.map(a => a.name === "coordination/coordinator" ? { ...a, model: pipelineConfig.models!.coordinator } : a)
				: augmentedAgents;
			coordinatorResult = await runSingleAgent(
				runtime,
				coordAgents,
				"coordination/coordinator",
				task,
				planDir,
				undefined,
				signal,
				coordOnUpdate as any,
				makeDetails,
				{
					outputLimits: pipelineConfig.maxOutput,
					artifactsDir: path.join(coordDir, "artifacts"),
					artifactLabel: "coordinator",
					parentModel: options.defaultModel,
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
			await obs.events.emit({ type: "checkpoint_saved", checkpointId, phase: "coordinator" } as any);

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

		// ── Context Compaction: distill session state at workers→review boundary ──
		if (!coordExitError && shouldRunPhase("review")) {
			try {
				const compactionWorkerStates = await storage.listWorkerStates();
				const completedTasksForDigest: CompletedTask[] = compactionWorkerStates
					.filter(w => w.status === "complete")
					.map(w => ({
						taskId: w.id,
						title: w.identity,
						filesModified: w.filesModified,
						summary: undefined,
					}));

				const sessionDigest = await compactSession(
					coordDir,
					coordSessionId,
					completedTasksForDigest,
					planContent,
					"workers",
				);
				console.log(`[context] Session digest saved — ${sessionDigest.filesModified.length} files, ${sessionDigest.completedTaskSummaries.length} tasks, ${sessionDigest.openQuestions.length} open questions`);

				// Prepend digest header to reviewer context (via env var for reviewer agent pickup)
				const contextHeader = buildWorkerContextHeader(sessionDigest);
				process.env.PI_SESSION_CONTEXT_HEADER = contextHeader;
			} catch (compactionErr) {
				// Non-fatal: compaction is a best-effort anti-drift measure
				console.warn(`[context] Session compaction failed (non-fatal): ${compactionErr}`);
			}
		}

		if (!coordExitError && shouldRunPhase("review")) {
			// HANDRaiser: check for buffered agent questions before review
			try {
				const currentEvents = await storage.getEvents();
				const questionEvents = currentEvents.filter(
					(e): e is Extract<typeof e, { type: "agent_question" }> =>
						e.type === "agent_question" && !(e as any).answered
				);
				if (questionEvents.length > 0) {
					const questionsPath = path.join(coordDir, "pending-questions.json");
					await fs.writeFile(questionsPath, JSON.stringify({
						questions: questionEvents.slice(0, 4),
						checkpoint: "pre-review",
						autoResumeInMs: 120000,
					}), "utf-8");
					// Surface visibly in the terminal
					const count = Math.min(questionEvents.length, 4);
					const bar = "═".repeat(62);
					console.log(`\n╔${bar}╗`);
					console.log(`║  ✋ ${count} agent${count > 1 ? "s have" : " has"} question${count > 1 ? "s" : ""} — answer before review begins    ║`);
					console.log(`╚${bar}╝`);
					for (const q of questionEvents.slice(0, 4)) {
						const name = (q.workerName || q.workerId).padEnd(12);
						console.log(`  ${name}  ${q.question}`);
						if (q.options && q.options.length > 0) {
							const chips = q.options.slice(0, 4)
								.map((opt, i) => `[${String.fromCharCode(65 + i)}] ${opt}`)
								.join("  ");
							console.log(`              ${chips}`);
						}
					}
					console.log(`\n  Questions saved to: ${questionsPath}\n`);
				}
			} catch {
				// Non-fatal: proceed to review regardless
			}
			await runReviewFixLoop(pipelineContext, pipelineConfig);
		}

		updatePhaseStatus("complete", "complete", pipelineContext);
		pipelineState.completedAt = Date.now();

		const finalState = await storage.getState();
		const workerStates = await storage.listWorkerStates();
		const events = await storage.getEvents();
		const finalReservations = await storage.getActiveReservations();
		const finalTaskProgress = await readTaskProgress(coordDir);
		const completedAt = Date.now();

		const detailsWithPipeline: CoordinationDetails = {
			...makeCoordDetails(coordinatorResult, finalState, workerStates, events, normalizeAgents(params.agents), finalReservations, finalTaskProgress),
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

		// ── Audit log: per-worker events + session complete ───────────────────
		try {
			for (const w of workerStates) {
				const eventType = w.status === "complete" ? "worker.complete" : "task.failed";
				auditLog.append({
					type: eventType,
					sessionId: coordSessionId,
					agentRole: "worker",
					taskId: w.identity,
					filesModified: w.filesModified,
					tokensIn: w.usage?.input,
					tokensOut: w.usage?.output,
					costUsd: w.usage?.cost,
				});
			}
			auditLog.append({
				type: isError ? "session.error" : "session.complete",
				sessionId: coordSessionId,
				agentRole: "coordinator",
				costUsd: costState.total,
			});
		} catch (auditErr) {
			console.error(`[audit] Failed to write audit log: ${auditErr}`);
		}

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

		// ── QA Feedback Loop: auto-resolve failures for files modified this session ──
		let qaResolvedIds: string[] = [];
		if (!isError) {
			try {
				const allModifiedFiles = [...new Set(workerStates.flatMap(w => w.filesModified))];
				qaResolvedIds = await autoResolveFailuresForSession(allModifiedFiles, coordSessionId);
			} catch (qaErr) {
				// Non-fatal
				console.error(`[qa-loop] Auto-resolve failed: ${qaErr}`);
			}
		}

		// Generate HTML recap
		let recapPath: string | undefined;
		try {
			const { generateCoordinationRecap } = await import("./recap-generator.js");
			const tasksForRecap = await (async () => {
				try {
					const tasksPath = path.join(coordDir, "tasks.json");
					const content = await fs.readFile(tasksPath, "utf-8");
					return JSON.parse(content).tasks || [];
				} catch { return []; }
			})();
			recapPath = await generateCoordinationRecap(
				{ coordDir, planPath, costLimit: params.costLimit, sessionId: coordSessionId, hitlMode: (params.hitl as HITLMode) ?? "permissive" },
				{
					status: isError ? "failed" : "complete",
					startedAt: initialState.startedAt,
					completedAt,
					exitReason: pipelineState.exitReason,
				},
				workerStates,
				tasksForRecap,
				events,
				qaResolvedIds,
			);
			process.stdout.write(`\n📄 Session recap: ${recapPath}\n`);
			// Open the recap
			const { exec: execChild } = await import("child_process");
			const openScript = `${os.homedir()}/.pi/agent/scripts/open-html-artifact.sh`;
			if (fsSync.existsSync(openScript)) {
				execChild(`bash "${openScript}" "${recapPath}"`, (err) => {
					if (err) execChild(`open "${recapPath}"`);
				});
			} else {
				execChild(`open "${recapPath}"`);
			}
		} catch (recapErr) {
			console.error(`Failed to generate recap: ${recapErr}`);
		}

		const recapSuffix = recapPath ? `\n\nRecap: ${recapPath}` : "";

		// ─────────────────────────────────────────────────────────────────────
		// Clean up progress.json on successful completion so subsequent runs
		// start fresh rather than skipping tasks that already ran.
		// ─────────────────────────────────────────────────────────────────────
		if (!isError) {
			await deleteProgressSnapshot(coordDir);
		}

		return {
			result: {
				content: [{ type: "text", text: finalSummary + recapSuffix }],
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

		// ── Audit log: fatal session error ────────────────────────────────────
		try {
			auditLog.append({
				type: "session.error",
				sessionId: coordSessionId,
				agentRole: "coordinator",
				costUsd: costState.total,
				decision: String(err),
			});
		} catch {
			// Best-effort — don't mask the original error
		}

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
			"Start multi-agent coordination session. Pass any markdown file (spec, PRD, plan) directly - the planner decomposes it into parallel tasks. Don't rewrite or convert the file first. Saves a markdown log to the project directory (configurable via logPath parameter or PI_COORDINATION_LOG_DIR env var).",
		parameters: CoordinateParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<any> {
			const typedParams = params as CoordinateParamsType;
			const resultsDir = resolveAsyncResultsDir(ctx.cwd, typedParams.asyncResultsDir);

			// ── Background (overnight) mode ───────────────────────────────────
			// Detaches the run into a child process so the user can close their
			// terminal and come back later to find results.
			if (typedParams.background) {
				try {
					const { startBackgroundRun } = await import("./background-runner.js");
					const specPath = path.resolve(ctx.cwd, typedParams.plan);
					try {
						await fs.access(specPath);
					} catch (err) {
						return {
							content: [{ type: "text", text: `Failed to read plan file: ${specPath}\n${err}` }],
							isError: true,
						};
					}
					const opts: Record<string, unknown> = { ...typedParams, background: false };
					const run = await startBackgroundRun(specPath, opts as any, ctx.cwd);
					const specName = path.basename(specPath, path.extname(specPath));
					return {
						content: [{
							type: "text",
							text: [
								`[background] run ${run.id} started — spec: ${specName}`,
								`  watch: tail -f ${run.logPath}`,
								`  status: cat ${run.statusPath}`,
								`  or: bash scripts/pi-status.sh ${run.id}`,
							].join("\n"),
						}],
						details: { backgroundRun: run },
					};
				} catch (err) {
					return {
						content: [{ type: "text", text: `Failed to start background run: ${err}` }],
						isError: true,
					};
				}
			}

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

			// When resume === true, look for a previously-interrupted run of
			// the same spec so we can resume in the same coordination directory.
			let resumeCoordDir: string | undefined;
			if (typedParams.resume === true) {
				try {
					const planPath = path.resolve(ctx.cwd, typedParams.plan);
					const planContent = await fs.readFile(planPath, "utf-8");
					const specHash = hash(planContent);
					const sessionDir = process.env.PI_SESSION_DIR || path.join(os.homedir(), ".pi", "sessions", "default");
					const found = await findResumeCoordDir(sessionDir, specHash);
					if (found) {
						console.log(`[resume] Found checkpoint in ${found}`);
						resumeCoordDir = found;
					}
				} catch {
					// Non-fatal: fall back to a fresh run
				}
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
				...(resumeCoordDir ? { coordDir: resumeCoordDir } : {}),
			});
			return result;
		},

		renderCall(args, theme) {
			const planPath = args.plan || "...";
			const agentCount = Array.isArray(args.agents) ? args.agents.length : (args.agents || 0);
			const asyncLabel = args.async ? theme.fg("warning", " [async]") : "";
			const backgroundLabel = (args as any).background ? theme.fg("warning", " [background]") : "";
			const expandHint = theme.fg("dim", " [Ctrl+O: expand]");
			let text = theme.fg("toolTitle", theme.bold("coordinate ")) +
				theme.fg("accent", planPath) +
				theme.fg("muted", ` (${agentCount} agents)`) +
				asyncLabel +
				backgroundLabel +
				expandHint;
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
			const workers = details.workers || [];
			const events = details.events || [];
			const allDone = workers.length > 0 &&
				workers.every(w => w.status === "complete" || w.status === "failed");
			const width = Math.min(process.stdout.columns || 120, 120); // Dynamic width, max 120

			// Convert to display state for shared renderers
			const workerDisplays: WorkerDisplayState[] = workers.map(w => workerStateToDisplay(w as any));
			
			// Build pipeline state
			const pipelineState: PipelineDisplayState | null = details.pipeline ? {
				currentPhase: details.pipeline.currentPhase,
				phases: details.pipeline.phases,
				cost: details.cost?.total || 0,
				costByPhase: details.cost?.byPhase,
				elapsed: Date.now() - (details.startedAt || Date.now()),
				costLimit: details.cost?.limit,
			} : null;

			// ─────────────────────────────────────────────────────────────────
			// Completed state - show summary table
			// ─────────────────────────────────────────────────────────────────
			if (allDone) {
				const totalTime = Date.now() - (details.startedAt || Date.now());
				// Use full cost from costState (includes scout, planner, coordinator, review)
				const totalCost = details.cost?.total || workers.reduce((sum, w) => sum + w.usage.cost, 0);
				const failed = workers.filter(w => w.status === "failed").length;

				const headerIcon = failed > 0 ? ICONS.failed : ICONS.complete;
				const headerText = failed > 0
					? `${headerIcon} Coordination Failed`
					: `${headerIcon} Coordination Complete`;

				container.addChild(new Text(drawBoxTop(width, headerText, theme), 0, 0));
				
				// Summary line
				const summaryLine = `${theme.fg("muted", "Duration:")} ${formatDuration(totalTime)}  ${theme.fg("muted", "Cost:")} ${formatCost(totalCost)}  ${theme.fg("muted", "Workers:")} ${workers.length}`;
				container.addChild(new Text(drawBoxLine(summaryLine, width, theme), 0, 0));
				container.addChild(new Text(drawBoxLine("", width, theme), 0, 0));

				// Worker table header (13 chars for name - max is "bright_badger")
				const tableHeader = `  ${theme.fg("dim", "Worker".padEnd(13))} ${theme.fg("dim", "Time".padEnd(8))} ${theme.fg("dim", "Cost".padEnd(8))} ${theme.fg("dim", "Turns".padEnd(6))} ${theme.fg("dim", "Files")}`;
				container.addChild(new Text(drawBoxLine(tableHeader, width, theme), 0, 0));

				const workersTotalCost = workers.reduce((sum, w) => sum + w.usage.cost, 0);
				const costRolledUpToCoordinator = workersTotalCost === 0 && totalCost > 0 && workers.some(w => w.filesModified.length > 0);

				for (const w of workers) {
					const statusIcon = w.status === "complete"
						? theme.fg("success", ICONS.complete)
						: theme.fg("error", ICONS.failed);
					const name = generateMemorableName(w.identity);
					const time = w.completedAt && w.startedAt
						? formatDuration(w.completedAt - w.startedAt)
						: "--";
					const cost = costRolledUpToCoordinator ? theme.fg("dim", "(coord)") : formatCost(w.usage.cost);
					const turns = w.usage.turns.toString();
					const files = w.filesModified.slice(0, 2).map(f => path.basename(f)).join(", ") +
						(w.filesModified.length > 2 ? "..." : "");

					const row = `${statusIcon} ${theme.fg("accent", name.padEnd(13))} ${time.padEnd(8)} ${cost.padEnd(8)} ${turns.padEnd(6)} ${theme.fg("dim", files)}`;
					container.addChild(new Text(drawBoxLine(row, width, theme), 0, 0));
				}

				// Note: when coordinator dispatches workers via spawn_workers tool, all API costs
				// are attributed to the coordinator phase. The total cost above is accurate.
				if (costRolledUpToCoordinator) {
					const note = `  ${theme.fg("dim", "ℹ")} Worker costs rolled up to coordinator (via coordinator) — total: ${formatCost(totalCost)}`;
					container.addChild(new Text(drawBoxLine(note, width, theme), 0, 0));
				}

				container.addChild(new Text(drawBoxBottom(width, theme), 0, 0));

				// Coordinator summary if available
				const output = details.coordinatorResult ? getResultOutput(details.coordinatorResult) : "";
				if (output) {
					container.addChild(new Text("", 0, 0));
					container.addChild(new Text(theme.fg("muted", "─── Summary ───"), 0, 0));
					const lines = output.split("\n").slice(0, 10);
					for (const line of lines) {
						container.addChild(new Text(theme.fg("dim", line.slice(0, 100)), 0, 0));
					}
				}

				return container;
			}

			// ─────────────────────────────────────────────────────────────────
			// In-progress state - show live dashboard
			// ─────────────────────────────────────────────────────────────────
			container.addChild(new Text(drawBoxTop(width, "Coordination", theme), 0, 0));

			// 2026 four-level coordination dashboard
			if (pipelineState) {
				// Build task-centric entries from worker display states
				const taskEntries: TaskCentricEntry[] = workerDisplays
					.filter(w => !!w.taskId)
					.map(w => ({
						id: w.taskId!,
						title: w.taskTitle || w.taskId!,
						status: (w.status === "complete" || w.status === "failed" || w.status === "working" || w.status === "pending"
							? w.status
							: "working") as TaskCentricEntry["status"],
						workerName: w.name,
						durationMs: w.durationMs,
						cost: w.cost,
						currentFile: w.currentFile ?? undefined,
					}));

				const dashboardLines = renderCoordinationDashboard(
					path.basename(details.planPath || "coordination"),
					pipelineState,
					workerDisplays,
					taskEntries,
					theme,
					width - 4,
					true,        // modelRoutingEnabled
					pipelineState?.costLimit,  // pass costLimit for cap display
					true,        // memoryEnabled: context compaction is always active
				);
				for (const line of dashboardLines) {
					container.addChild(new Text(drawBoxLine(line, width, theme), 0, 0));
				}
			} else if (workers.length > 0) {
				// No pipeline state yet — fall back to compact worker view
				const workerLines = renderWorkersCompact(workerDisplays, theme, width - 4);
				for (const line of workerLines) {
					container.addChild(new Text(drawBoxLine(line, width, theme), 0, 0));
				}
			} else if (details.pendingAgents && details.pendingAgents.length > 0) {
				// Show pending agents with spinner
				const spinner = getSpinnerFrame();
				let line = "";
				for (const agent of details.pendingAgents.slice(0, 4)) {
					line += `${theme.fg("warning", spinner)} ${theme.fg("accent", agent)}  `;
				}
				if (details.pendingAgents.length > 4) {
					line += theme.fg("dim", `+${details.pendingAgents.length - 4} more`);
				}
				container.addChild(new Text(drawBoxLine(line, width, theme), 0, 0));
			}

			// File reservations section
			if (details.reservations && details.reservations.length > 0) {
				const reservationLines = renderFileReservations(details.reservations, theme, width - 4);
				for (const line of reservationLines) {
					container.addChild(new Text(drawBoxLine(line, width, theme), 0, 0));
				}
			}

			container.addChild(new Text(drawBoxBottom(width, theme), 0, 0));

			// Cost breakdown (outside box)
			if (pipelineState?.costByPhase) {
				const costLine = renderCostBreakdown(pipelineState.costByPhase, theme);
				if (costLine) {
					container.addChild(new Text(costLine, 0, 0));
				}
			}

			// Events section (outside box for live streaming feel)
			if (events.length > 0) {
				container.addChild(new Text("", 0, 0));
				// Expanded: show 25 events with full paths; Normal: 8 events truncated
				const eventCount = expanded ? 25 : 8;
				const recentEvents = events.slice(-eventCount);
				const firstTs = events[0]?.timestamp || Date.now();

				for (const ev of recentEvents) {
					const line = renderEventLine(ev, firstTs, theme, expanded);
					container.addChild(new Text(line, 0, 0));
				}
				
				if (expanded && events.length > eventCount) {
					container.addChild(new Text(theme.fg("dim", `  ... ${events.length - eventCount} earlier events`), 0, 0));
				}
			}

			return container;
		},
	};

	return tool;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit log verification helper — for `pi audit verify` command path
// ─────────────────────────────────────────────────────────────────────────────

export { verifyAuditLog } from "./audit-log.js";
