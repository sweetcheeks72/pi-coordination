import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runSingleAgent, type AgentRuntime } from "../../subagent/runner.js";
import { discoverAgents } from "../../subagent/agents.js";
import { TaskQueueManager } from "../task-queue.js";
import type { Task } from "../types.js";
import type { OutputLimits } from "../../subagent/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLANNER_EXTENSION_PATH = path.resolve(__dirname, "../../../extensions/coordination/planner.ts");

export interface PlannerPhaseConfig {
	humanCheckpoint?: boolean;
	maxSelfReviewCycles?: number;
	model?: string;
	outputLimits?: OutputLimits;
	agentName?: string;
	scoutContextPath?: string;
}

export interface PlannerResult {
	tasks: Task[];
	selfReviewCycles: number;
	duration: number;
	cost: number;
	approved: boolean;
}

export async function runPlannerPhase(
	runtime: AgentRuntime,
	planContent: string,
	scoutContext: string,
	coordDir: string,
	config: PlannerPhaseConfig,
	signal?: AbortSignal,
): Promise<PlannerResult> {
	const startTime = Date.now();
	const { agents } = discoverAgents(runtime.cwd, "user");

	const scoutContextPath = config.scoutContextPath || path.join(coordDir, "scout", "main.md");
	const scoutFileExists = await fileExists(scoutContextPath);

	let scoutSection: string;
	if (scoutFileExists) {
		scoutSection = `## Scout Context

The scout has analyzed the codebase. Use the \`read_context\` tool to read the full context:

\`\`\`
read_context({ path: "${scoutContextPath}" })
\`\`\`

You can also read specific sections:
- \`read_context({ path: "${scoutContextPath}", section: "file_map" })\` - Get the file tree
- \`read_context({ path: "${scoutContextPath}", section: "file_contents" })\` - Get file contents

Read the context FIRST before creating the task graph.`;
	} else if (scoutContext.trim()) {
		scoutSection = `## Scout Context (Codebase Analysis)\n${scoutContext}`;
	} else {
		scoutSection = "## Scout Context\n(No scout context provided - analyze the codebase as needed)";
	}

	const task = `Create a task graph for the following implementation plan.

${scoutSection}

## Implementation Plan
${planContent}

## Instructions

1. FIRST: Use \`read_context\` to read the scout context file
2. Analyze the file_map to understand project structure  
3. Review file_contents to understand existing code patterns
4. Create a task graph based on the plan and codebase analysis

## Output Requirements

Output a valid JSON object with a "tasks" array. Each task should have:
- id: Unique identifier (e.g., "TASK-01")
- description: Clear description of what to implement
- priority: 0=critical, 1=high, 2=medium, 3=low
- files: Array of files to modify (optional)
- creates: Array of new files to create (optional)
- dependsOn: Array of task IDs this depends on
- acceptanceCriteria: Array of criteria for completion

Rules:
1. No file overlaps without dependencies
2. At least one task must have no dependencies
3. Include a final integration task
4. Keep tasks atomic (completable in one session)

## Self-Review Required

After generating the task graph, you MUST review it with "fresh eyes" checking for:

1. STRUCTURAL ISSUES:
   - Dependency cycles (A depends on B depends on A)
   - File overlaps without dependencies (collision risk)
   - Missing entry points (no task with dependsOn: [])
   - Missing integration task

2. GRANULARITY ISSUES:
   - Tasks too large (should be split)
   - Tasks too small (should be combined)

3. COMPLETENESS ISSUES:
   - PRD requirements not covered
   - Vague acceptance criteria

4. PRIORITY ISSUES:
   - Critical path not prioritized
   - Everything marked P:1

If you find issues during self-review, fix them before outputting.
Output ONLY the final JSON object after self-review, no other text.`;

	const agentName = config.agentName || "coordination/planner";
	const agentsWithOverride = config.model
		? agents.map((a) => (a.name === agentName ? { ...a, model: config.model } : a))
		: agents;

	const result = await runSingleAgent(
		runtime,
		agentsWithOverride,
		agentName,
		task,
		runtime.cwd,
		undefined,
		signal,
		undefined,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
		{
			outputLimits: config.outputLimits,
			artifactsDir: path.join(coordDir, "artifacts"),
			artifactLabel: "planner",
			extensions: [PLANNER_EXTENSION_PATH],
		},
	);

	const output = extractTextFromResult(result);
	const tasks = parseTasksFromOutput(output);

	if (tasks.length === 0) {
		throw new Error("Planner failed to generate valid task graph");
	}

	return {
		tasks,
		selfReviewCycles: 1,
		duration: Date.now() - startTime,
		cost: result.usage.cost,
		approved: true,
	};
}

export async function createTaskQueueFromPlanner(
	coordDir: string,
	planPath: string,
	tasks: Task[],
): Promise<void> {
	const planContent = await fs.readFile(planPath, "utf-8");
	const planHash = createHash("md5").update(planContent).digest("hex").slice(0, 8);

	const taskQueue = new TaskQueueManager(coordDir);
	await taskQueue.createFromPlan(planPath, planHash, tasks);
}

export async function runPlannerBackgroundReview(
	runtime: AgentRuntime,
	coordDir: string,
	config: PlannerPhaseConfig,
	signal?: AbortSignal,
): Promise<void> {
	const { agents } = discoverAgents(runtime.cwd, "user");
	const taskQueue = new TaskQueueManager(coordDir);
	const agentName = config.agentName || "coordination/planner";

	const agentsWithOverride = config.model
		? agents.map((a) => (a.name === agentName ? { ...a, model: config.model } : a))
		: agents;

	const checkInterval = 5000;

	while (!signal?.aborted) {
		const tasksToReview = await taskQueue.getTasksForReview();

		if (tasksToReview.length === 0) {
			await new Promise((r) => setTimeout(r, checkInterval));
			continue;
		}

		for (const task of tasksToReview) {
			if (signal?.aborted) break;

			const reviewTask = `Review this discovered task and determine if it should be approved.

## Task
ID: ${task.id}
Description: ${task.description}
Priority: ${task.priority}
Files: ${task.files?.join(", ") || "none specified"}
Discovered From: ${task.discoveredFrom}
Acceptance Criteria: ${task.acceptanceCriteria?.join(", ") || "none specified"}

## Review Criteria
1. Is this within scope of the current plan?
2. Is it duplicated by another existing task?
3. Does it conflict with file ownership of other tasks?
4. Are the dependencies correct?
5. Is the priority appropriate?

Respond with JSON:
{
  "approved": true/false,
  "modified": true/false,
  "modifications": { ... } (if modified),
  "reason": "explanation"
}`;

			try {
				const result = await runSingleAgent(
					runtime,
					agentsWithOverride,
					agentName,
					reviewTask,
					runtime.cwd,
					undefined,
					signal,
					undefined,
					(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
					{
						outputLimits: config.outputLimits,
						artifactsDir: path.join(coordDir, "artifacts"),
						artifactLabel: `planner-review-${task.id}`,
					},
				);

				const outputText = extractTextFromResult(result);
				const reviewResult = parseReviewResult(outputText);

				if (reviewResult.approved) {
					await taskQueue.approveTask(task.id, reviewResult.modifications);
				} else {
					await taskQueue.rejectTask(task.id, reviewResult.reason || "Rejected by planner");
				}
			} catch (err) {
				console.error(`Failed to review task ${task.id}:`, err);
			}
		}

		await new Promise((r) => setTimeout(r, checkInterval));
	}
}

function extractTextFromResult(result: { messages?: Array<{ role: string; content: unknown }> }): string {
	if (!result.messages) return "";

	for (let i = result.messages.length - 1; i >= 0; i--) {
		const msg = result.messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const textBlocks = msg.content.filter(
				(b: unknown) => typeof b === "object" && b !== null && (b as { type: string }).type === "text"
			);
			return textBlocks.map((b: { text?: string }) => b.text || "").join("\n");
		}
	}

	return "";
}

function parseTasksFromOutput(output: string): Task[] {
	const jsonMatch = output.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
	if (!jsonMatch) return [];

	try {
		const parsed = JSON.parse(jsonMatch[0]);
		if (Array.isArray(parsed.tasks)) {
			return parsed.tasks.map((t: Partial<Task>) => ({
				id: t.id || `TASK-${Math.random().toString(36).slice(2, 6)}`,
				description: t.description || "",
				priority: t.priority ?? 2,
				status: "pending" as const,
				files: t.files,
				creates: t.creates,
				dependsOn: t.dependsOn,
				acceptanceCriteria: t.acceptanceCriteria,
			}));
		}
	} catch {}

	return [];
}

function parseReviewResult(output: string): {
	approved: boolean;
	modified: boolean;
	modifications?: Partial<Task>;
	reason?: string;
} {
	const jsonMatch = output.match(/\{[\s\S]*"approved"[\s\S]*\}/);
	if (!jsonMatch) {
		return { approved: false, modified: false, reason: "Failed to parse review result" };
	}

	try {
		const parsed = JSON.parse(jsonMatch[0]);
		return {
			approved: !!parsed.approved,
			modified: !!parsed.modified,
			modifications: parsed.modifications,
			reason: parsed.reason,
		};
	} catch {
		return { approved: false, modified: false, reason: "Failed to parse review result" };
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
