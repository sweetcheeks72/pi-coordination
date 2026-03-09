/**
 * Integration Review Phase
 * 
 * Runs after all workers complete, before the regular review-fix loop.
 * Focuses specifically on cross-component integration issues:
 * - How different workers' changes interact
 * - Cross-file dependencies and imports
 * - API contract violations
 * - Data flow between components
 * - Shared state consistency
 */

import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { runSingleAgent } from "../../subagent/runner.js";
import { discoverAgents } from "../../subagent/agents.js";
import { getResultOutput } from "../../subagent/render.js";
import type { ReviewIssue, WorkerStateFile } from "../types.js";
import type { AgentRuntime } from "../../subagent/runner.js";
import type { OutputLimits } from "../../subagent/types.js";

const execAsync = promisify(exec);

export interface IntegrationReviewConfig {
	model?: string;
	outputLimits?: OutputLimits;
	onProgress?: (update: { details?: unknown }) => void;
}

export interface IntegrationReviewResult {
	issues: ReviewIssue[];
	summary: string;
	allPassing: boolean;
	duration: number;
	cost: number;
}

export async function runIntegrationReview(
	runtime: AgentRuntime,
	coordDir: string,
	planContent: string,
	workerStates: WorkerStateFile[],
	config: IntegrationReviewConfig,
	signal?: AbortSignal,
): Promise<IntegrationReviewResult> {
	const startTime = Date.now();

	// Get all modified files
	const allModifiedFiles = [...new Set(workerStates.flatMap(w => w.filesModified))];

	// Short-circuit if no files were modified or only one worker
	if (allModifiedFiles.length === 0 || workerStates.length <= 1) {
		return {
			issues: [],
			summary: workerStates.length <= 1 
				? "Single worker - no cross-component integration to review"
				: "No files modified - no integration review needed",
			allPassing: true,
			duration: Date.now() - startTime,
			cost: 0,
		};
	}

	const { agents } = discoverAgents(runtime.cwd, "user");

	// Group files by worker to understand who changed what
	const workerChanges = workerStates.map(w => ({
		identity: w.identity,
		files: w.filesModified,
		task: w.handshakeSpec.split('\n')[0], // First line of task
	}));
	
	// Find files modified by multiple workers (potential conflict points)
	const fileWorkerMap = new Map<string, string[]>();
	for (const w of workerStates) {
		for (const f of w.filesModified) {
			const workers = fileWorkerMap.get(f) || [];
			workers.push(w.identity);
			fileWorkerMap.set(f, workers);
		}
	}
	const sharedFiles = [...fileWorkerMap.entries()]
		.filter(([_, workers]) => workers.length > 1)
		.map(([file, workers]) => ({ file, workers }));

	// Get git diff
	let gitDiff = "";
	if (allModifiedFiles.length > 0) {
		try {
			const quotedFiles = allModifiedFiles.map(f => `"${f.replace(/"/g, '\\"')}"`).join(" ");
			const { stdout } = await execAsync(`git diff HEAD -- ${quotedFiles}`, { cwd: runtime.cwd });
			gitDiff = stdout;
		} catch {
			gitDiff = "(git diff unavailable)";
		}
	}

	const task = `## Integration Review

You are reviewing how multiple workers' changes integrate together. This is NOT about finding bugs in individual files - that comes later. Focus ONLY on integration issues.

### Original Plan
\`\`\`markdown
${planContent}
\`\`\`

### Worker Changes Summary
${workerChanges.map(w => `
**${w.identity}**
- Task: ${w.task}
- Modified: ${w.files.join(", ") || "none"}
`).join("\n")}

### Files Modified by Multiple Workers (Potential Conflicts)
${sharedFiles.length > 0 
	? sharedFiles.map(s => `- **${s.file}** → ${s.workers.join(", ")}`).join("\n")
	: "None - each file modified by only one worker"}

### Git Diff
\`\`\`diff
${gitDiff}
\`\`\`

### Integration Review Focus

**You MUST use the \`read\` tool to read each modified file in full.** Then check:

1. **Cross-file dependencies**: Do imports/exports match up correctly between workers' changes?
2. **API contracts**: If Worker A added a function and Worker B calls it, do the signatures match?
3. **Shared types**: Are type definitions consistent across all usages?
4. **Data flow**: If data flows through multiple components, is it transformed correctly?
5. **State consistency**: Are shared state updates coordinated properly?
6. **File conflicts**: For files modified by multiple workers, are the changes compatible?

### What NOT to Report
- Individual file bugs (leave for bug review)
- Style issues
- Minor typos
- Issues that don't involve cross-component interaction

### Output Format
Return a JSON object (no markdown code fences, just raw JSON):
{
  "allPassing": boolean,
  "summary": "Brief integration assessment",
  "issues": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "error" | "warning",
      "category": "integration",
      "description": "What's wrong with the integration",
      "suggestedFix": "How to fix the integration issue",
      "relatedFiles": ["other/file.ts"],
      "relatedWorkers": ["worker:task-01", "worker:task-02"]
    }
  ]
}

Only report issues that are truly integration problems between different workers' changes.
If all components integrate correctly, set allPassing: true.`;

	const agentsWithOverride = config.model
		? agents.map(a => a.name === "coordination/reviewer" ? { ...a, model: config.model } : a)
		: agents;

	const result = await runSingleAgent(
		runtime,
		agentsWithOverride,
		"coordination/reviewer",
		task,
		runtime.cwd,
		undefined,
		signal,
		config.onProgress,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
		{ outputLimits: config.outputLimits, artifactsDir: path.join(coordDir, "artifacts"), artifactLabel: "integration-review", parentModel: config.model },
	);

	let output = getResultOutput(result);
	if (result.truncated && result.artifactPaths?.outputPath) {
		output = await fs.readFile(result.artifactPaths.outputPath, "utf-8").catch(() => output);
	}

	let parsed: { allPassing: boolean; summary: string; issues: Partial<ReviewIssue>[] };
	
	try {
		const jsonMatch = output.match(/\{[\s\S]*\}/);
		parsed = JSON.parse(jsonMatch?.[0] || output);
	} catch {
		parsed = {
			allPassing: true, // If parse fails, assume no integration issues
			summary: "Failed to parse integration review output",
			issues: [],
		};
	}

	const issues = (parsed.issues || []).map((i) => ({
		id: randomUUID(),
		file: i.file || "unknown",
		line: i.line,
		severity: i.severity || "warning",
		category: "integration" as const,
		description: i.description || "",
		suggestedFix: i.suggestedFix,
		fixAttempts: 0,
	})) as ReviewIssue[];

	return {
		issues,
		summary: parsed.summary || "",
		allPassing: parsed.allPassing ?? issues.length === 0,
		duration: Date.now() - startTime,
		cost: result.usage.cost,
	};
}
