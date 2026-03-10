import { randomUUID } from "node:crypto";
import type { ReviewIssue, WorkerStateFile } from "../types.js";
import type { AgentRuntime } from "../../subagent/runner.js";
import { FileBasedStorage } from "../state.js";
import { spawnWorkerProcess, type WorkerHandle, type SDKWorkerHandle } from "../coordinator-tools/index.js";
import type { ObservabilityContext } from "../observability/index.js";

function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
	const result = {} as Record<K, T[]>;
	for (const item of items) {
		const key = keyFn(item);
		(result[key] ||= []).push(item);
	}
	return result;
}

export interface FixConfig {
	maxCycles: number;
	sameIssueLimit: number;
}

export interface FixResult {
	cycleNumber: number;
	issuesFixed: number;
	issuesRemaining: number;
	exitReason: "clean" | "stuck" | "regression" | "max_cycles" | "escalated";
	duration: number;
	cost: number;
}

export async function runFixPhase(
	runtime: AgentRuntime,
	coordDir: string,
	issues: ReviewIssue[],
	workerStates: WorkerStateFile[],
	config: FixConfig,
	cycleNumber: number,
	_signal?: AbortSignal,
	obs?: ObservabilityContext,
): Promise<FixResult> {
	const startTime = Date.now();
	const storage = new FileBasedStorage(coordDir);

	if (cycleNumber >= config.maxCycles) {
		return {
			cycleNumber,
			issuesFixed: 0,
			issuesRemaining: issues.length,
			exitReason: "max_cycles",
			duration: Date.now() - startTime,
			cost: 0,
		};
	}

	const issuesByFile = groupBy(issues, i => i.file);
	const workersByFile = new Map<string, WorkerStateFile>();
	for (const w of workerStates) {
		for (const f of w.filesModified) {
			workersByFile.set(f, w);
		}
	}

	const workerIssues = new Map<string, ReviewIssue[]>();
	for (const [file, fileIssues] of Object.entries(issuesByFile)) {
		const worker = workersByFile.get(file);
		if (worker) {
			const existing = workerIssues.get(worker.id) || [];
			workerIssues.set(worker.id, [...existing, ...fileIssues]);
		}
	}

	const handles: (WorkerHandle | SDKWorkerHandle)[] = [];
	let totalCost = 0;

	for (const [originalWorkerId, workerIssueList] of workerIssues) {
		const originalWorker = workerStates.find(w => w.id === originalWorkerId);
		if (!originalWorker) continue;

		const prompt = generateFixPrompt(originalWorker, workerIssueList);

		const fixWorkerId = randomUUID();
		const fixShortId = fixWorkerId.slice(0, 4);
		const fixIdentity = `worker:${originalWorker.agent}-fix-${fixShortId}`;

		const handle = spawnWorkerProcess(
			{
				agent: originalWorker.agent,
				handshakeSpec: prompt,
				steps: [],
				logicalName: `fix-${originalWorker.shortId}`,
				workerId: fixWorkerId,
				identity: fixIdentity,
			},
			coordDir,
			runtime.cwd,
			storage,
			undefined,
			obs,
		);
		handles.push(handle);
	}

	const exitCodes = await Promise.all(handles.map(h => h.promise));
	const failedCount = exitCodes.filter(code => code !== 0).length;

	const spawnedWorkerIds = new Set(handles.map(h => h.workerId));
	const updatedWorkers = await storage.listWorkerStates();
	const fixWorkers = updatedWorkers.filter(w => spawnedWorkerIds.has(w.id));
	totalCost = fixWorkers.reduce((sum, w) => sum + w.usage.cost, 0);

	const completedCount = fixWorkers.filter(w => w.status === "complete").length;
	const issuesFixed = (completedCount > 0 && handles.length > 0) 
		? Math.floor(issues.length * (completedCount / handles.length)) 
		: 0;
	const issuesRemaining = issues.length - issuesFixed;

	let exitReason: FixResult["exitReason"] = "clean";
	if (failedCount > 0) {
		exitReason = "stuck";
	} else if (issuesRemaining > 0) {
		exitReason = "stuck";
	}

	return {
		cycleNumber,
		issuesFixed,
		issuesRemaining,
		exitReason,
		duration: Date.now() - startTime,
		cost: totalCost,
	};
}

function generateFixPrompt(
	worker: WorkerStateFile,
	issues: ReviewIssue[],
): string {
	const issueList = issues.map((i, idx) => `### Issue ${idx + 1}: ${i.file}${i.line ? `:${i.line}` : ""}
**${i.severity}** (${i.category}): ${i.description}
${i.suggestedFix ? `Suggested fix: ${i.suggestedFix}` : ""}
`).join("\n");

	return `## Fix Cycle

You previously implemented work as part of a coordination session.
The reviewer found these issues in your files:

${issueList}

## Required Process

For EACH issue above:

1. **Read the file** to understand current state
2. **Make the fix** addressing the specific issue
3. **Verify your fix** by reading the file again and confirming:
   - The specific issue is resolved
   - No new issues were introduced
   - The code compiles/parses correctly

## Self-Verification Checklist

Before completing, verify each issue:
${issues.map((i, idx) => `- [ ] Issue ${idx + 1} (${i.file}): Fixed and verified`).join("\n")}

Only call \`agent_work({ action: 'complete' })\` after you have:
1. Fixed ALL issues listed above
2. Verified EACH fix by reading the modified files
3. Confirmed no regressions were introduced

Your original task was:
${worker.handshakeSpec}
`;
}
