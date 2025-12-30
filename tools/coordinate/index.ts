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
import type { CoordinationState, CoordinationEvent, WorkerStateFile, WorkerStatus, CoordinationStatus } from "./types.js";

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
}

type OnUpdateCallback = (partial: AgentToolResult<CoordinationDetails>) => void;

const CoordinateParams = Type.Object({
	plan: Type.String({ description: "Path to markdown plan file" }),
	agents: Type.Array(Type.String(), { description: "Agent types to use (e.g. ['worker', 'worker'])" }),
});

const factory: CustomToolFactory = (pi) => {
	const tool: CustomAgentTool<typeof CoordinateParams, CoordinationDetails> = {
		name: "coordinate",
		label: "Coordinate",
		description:
			"Start multi-agent coordination session. Splits a plan across parallel workers, manages dependencies, and returns unified results.",
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

			const task = `## Coordination Session

You are managing a coordination session. Your job is to spawn worker agents and summarize results.

### Plan to Execute
\`\`\`markdown
${planContent}
\`\`\`

### Available Agent Types
${params.agents.join(", ")}

### Coordination Directory
${coordDir}

### Workflow

1. **Analyze the plan for dependencies**
   - Identify which steps depend on outputs from other steps
   - For each dependency, note: what is being produced, who produces it, who needs it

2. **Create contracts for dependencies** (if any exist)
   - Call create_contract() for each cross-worker dependency BEFORE spawning workers
   - Use logical worker names (worker-A, worker-B, etc.) that match handshakeSpec references
   - Workers will use wait_for_contract() to block until dependencies are ready
   - Workers will use signal_contract_complete() when they finish producing the dependency

3. **Call spawn_workers()** with detailed handshake specs
   - This spawns workers in parallel and WAITS for all to complete
   - Each worker needs: agent type, step numbers, and detailed handshakeSpec
   - If worker depends on another, include "Wait for contract 'X' before starting" in handshakeSpec
   - If worker provides something others need, include "Signal contract 'X' when complete" in handshakeSpec
   
4. **Call done()** with a summary of what was accomplished
   - done() validates that workers were spawned and completed successfully

### Example with Dependencies (Diamond Pattern):
\`\`\`
// Step 1: Create contract for the dependency
create_contract({
  item: "User type",
  type: "type", 
  provider: "worker-A",
  waiters: ["worker-B", "worker-C"],
  signature: "interface User { id: string; name: string; }"
})

// Step 2: Spawn workers with dependency info in handshakeSpec
spawn_workers({
  workers: [
    {
      "agent": "worker",
      "steps": [1],
      "handshakeSpec": "You are worker-A. Create src/types.ts with User interface (id: string, name: string). After creating the file, call signal_contract_complete({ item: 'User type', file: 'src/types.ts' })."
    },
    {
      "agent": "worker", 
      "steps": [2],
      "handshakeSpec": "You are worker-B. First call wait_for_contract({ item: 'User type' }) to wait for the User type to be ready. Then create src/service.ts with createUser function that imports User from ./types."
    },
    {
      "agent": "worker",
      "steps": [3], 
      "handshakeSpec": "You are worker-C. First call wait_for_contract({ item: 'User type' }) to wait for the User type to be ready. Then create src/validator.ts with validateUser function that imports User from ./types."
    }
  ]
})
\`\`\`

### Example without Dependencies (Parallel):
\`\`\`
// No contracts needed - just spawn workers
spawn_workers({
  workers: [
    {"agent": "worker", "steps": [1], "handshakeSpec": "Create src/file1.ts with a hello() function returning 'hello'."},
    {"agent": "worker", "steps": [2], "handshakeSpec": "Create src/file2.ts with a world() function returning 'world'."}
  ]
})
\`\`\`

### handshakeSpec Guidelines
- Be specific about file paths, function names, types
- Include what to import and export
- Describe the expected implementation details
- For providers: include "call signal_contract_complete({ item: 'X' }) when done"
- For waiters: include "call wait_for_contract({ item: 'X' }) before starting work"`;

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
				const result = await runSingleAgent(
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

				const finalState = await storage.getState();
				const workerStates = await storage.listWorkerStates();
				const events = await storage.getEvents();
				const details = makeCoordDetails(result, finalState, workerStates, events, params.agents);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";

				const summary = getFinalOutput(result.messages) ||
					(finalState.status === "complete" ? "Coordination completed" : `Coordination ended: ${finalState.status}`);

				return {
					content: [{ type: "text", text: summary }],
					details,
					isError,
				};
			} catch (err) {
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
					const shortId = ev.type === "cost_milestone"
						? "$"
						: (ev as { workerId?: string }).workerId?.slice(0, 4) || "??";

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
