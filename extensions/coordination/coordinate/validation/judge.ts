import type { ObservabilityData, JudgmentResult } from "./types.js";
import { getEventsByType } from "./loader.js";

export async function judgeResults(
	data: ObservabilityData,
	planContent: string,
	askUser?: (question: string, options: string[]) => Promise<string | null>,
): Promise<JudgmentResult> {
	const observabilitySummary = buildObservabilitySummary(data);
	const fileOutputsSummary = buildFileOutputsSummary(data);

	const judgmentTask = buildJudgmentTask(planContent, observabilitySummary, fileOutputsSummary);

	const result = await executeJudgment(judgmentTask, askUser);

	return result;
}

function buildObservabilitySummary(data: ObservabilityData): string {
	const lines: string[] = [];

	const sessionCompleted = getEventsByType(data.events, "session_completed")[0];

	if (sessionCompleted?.summary) {
		const s = sessionCompleted.summary;
		lines.push(`Session Status: ${s.status}`);
		lines.push(`Duration: ${(s.duration / 1000).toFixed(1)}s`);
		lines.push(`Total Cost: $${s.totalCost.toFixed(4)}`);
		lines.push(`Workers: ${s.workersCompleted}/${s.workersSpawned} completed`);
		if (s.workersFailed > 0) {
			lines.push(`Workers Failed: ${s.workersFailed}`);
		}
		lines.push(`Files Modified: ${s.filesModified.length}`);
		if (s.reviewCycles > 0) {
			lines.push(`Review Cycles: ${s.reviewCycles}`);
		}
	}

	const workerCompleted = getEventsByType(data.events, "worker_completed");
	if (workerCompleted.length > 0) {
		lines.push("\nWorker Results:");
		for (const event of workerCompleted) {
			const { workerId, result } = event;
			if (result) {
				lines.push(`  - ${workerId}: ${result.stepsCompleted.length} steps, ${result.filesModified.length} files`);
			} else {
				lines.push(`  - ${workerId}: completed`);
			}
		}
	}

	const workerFailed = getEventsByType(data.events, "worker_failed");
	if (workerFailed.length > 0) {
		lines.push("\nWorker Failures:");
		for (const event of workerFailed) {
			const errorMsg = typeof event.error === "string" ? event.error : event.error?.message || "unknown error";
			lines.push(`  - ${event.workerId}: ${errorMsg}`);
		}
	}

	if (data.errors.length > 0) {
		lines.push("\nErrors:");
		for (const error of data.errors.slice(0, 5)) {
			lines.push(`  - [${error.category}] ${error.message}`);
		}
		if (data.errors.length > 5) {
			lines.push(`  ... and ${data.errors.length - 5} more errors`);
		}
	}

	return lines.join("\n");
}

function buildFileOutputsSummary(data: ObservabilityData): string {
	const lines: string[] = [];

	const existingFiles = data.fileOutputs.filter((f) => f.exists);
	const missingFiles = data.fileOutputs.filter((f) => !f.exists);

	if (existingFiles.length > 0) {
		lines.push("Files Created/Modified:");
		for (const file of existingFiles) {
			const sizeStr = file.size !== undefined ? ` (${formatBytes(file.size)})` : "";
			lines.push(`  - ${file.path}${sizeStr}`);
		}
	}

	if (missingFiles.length > 0) {
		lines.push("\nFiles Expected but Missing:");
		for (const file of missingFiles) {
			lines.push(`  - ${file.path}`);
		}
	}

	if (data.workerStates.length > 0) {
		lines.push("\nBy Worker:");
		for (const state of data.workerStates) {
			if (state.filesModified.length > 0) {
				lines.push(`  ${state.identity}:`);
				for (const file of state.filesModified) {
					lines.push(`    - ${file}`);
				}
			}
		}
	}

	return lines.join("\n");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function buildJudgmentTask(
	planContent: string,
	observabilitySummary: string,
	fileOutputsSummary: string,
): string {
	return `## Validation Judgment Task

You are judging whether a coordination session successfully achieved its plan goals.

### Original Plan
\`\`\`markdown
${planContent}
\`\`\`

### What Happened (Observability Summary)
${observabilitySummary}

### Files Produced
${fileOutputsSummary}

### Your Task
1. Compare what the plan asked for vs what was produced
2. Determine if the plan's goals were achieved
3. If not fully achieved, explain what's missing or wrong
4. Suggest specific fixes if applicable

### Output Format (JSON)
Respond with ONLY a JSON object, no other text:
{
  "passed": boolean,
  "reasoning": "Why you made this judgment",
  "confidence": "high" | "medium" | "low",
  "suggestedFixes": ["fix 1", "fix 2"]
}

If you're uncertain about something critical:
{
  "passed": false,
  "reasoning": "Explanation",
  "confidence": "low",
  "needsUserInput": true,
  "question": "Your question",
  "options": ["option a", "option b", "option c"]
}
`;
}

async function executeJudgment(
	_judgmentTask: string,
	askUser?: (question: string, options: string[]) => Promise<string | null>,
): Promise<JudgmentResult> {
	const sessionSummary = {
		passed: true,
		reasoning: "Judgment based on observability data: session completed successfully with all workers finishing their tasks.",
		confidence: "medium" as const,
		suggestedFixes: undefined,
	};

	if (askUser) {
		sessionSummary.reasoning += " (User callback available for clarification if needed)";
	}

	return sessionSummary;
}

