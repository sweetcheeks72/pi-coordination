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

export interface ReviewConfig {
	model?: string;
	checkTests: boolean;
	verifyPlanGoals: boolean;
	outputLimits?: OutputLimits;
}

export interface NewTaskRequest {
	description: string;
	files?: string[];
	priority?: number;  // 0=critical, 1=high, 2=medium, 3=low (default: 1)
	reason: string;
}

export interface ReviewResult {
	issues: ReviewIssue[];
	summary: string;
	allPassing: boolean;
	filesReviewed: string[];
	duration: number;
	cost: number;
	newTasks?: NewTaskRequest[];
}

export async function runReviewPhase(
	runtime: AgentRuntime,
	coordDir: string,
	planContent: string,
	workerStates: WorkerStateFile[],
	config: ReviewConfig,
	signal?: AbortSignal,
): Promise<ReviewResult> {
	const startTime = Date.now();
	const { agents } = discoverAgents(runtime.cwd, "user");

	const modifiedFiles = [...new Set(workerStates.flatMap(w => w.filesModified))];
	
	let gitDiff = "";
	if (modifiedFiles.length > 0) {
		try {
			const quotedFiles = modifiedFiles.map(f => `"${f.replace(/"/g, '\\"')}"`).join(" ");
			const { stdout } = await execAsync(`git diff HEAD -- ${quotedFiles}`, { cwd: runtime.cwd });
			gitDiff = stdout;
		} catch {
			gitDiff = "(git diff unavailable)";
		}
	}

	const task = `## Coordination Review

Review all changes from this coordination session.

### Original Plan
\`\`\`markdown
${planContent}
\`\`\`

### Workers and Their Tasks
${workerStates.map(w => `
**${w.identity}** (${w.status})
- Files: ${w.filesModified.join(", ") || "none"}
- Task: ${w.handshakeSpec}
`).join("\n")}

### Git Diff of All Changes
\`\`\`diff
${gitDiff}
\`\`\`

### Review Requirements
1. Does the implementation achieve what the plan specified?
2. Any bugs, logic errors, or type issues?
${config.checkTests ? "3. If tests should exist, do they?" : ""}
${config.verifyPlanGoals ? "4. Verify each plan goal is met - list any unmet goals as issues." : ""}
5. Any regressions from the plan intent?

### Output Format
Return a JSON object (no markdown code fences, just raw JSON):
{
  "allPassing": boolean,
  "summary": "Brief overall assessment",
  "issues": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "error" | "warning" | "suggestion",
      "category": "bug" | "logic" | "type" | "style" | "missing" | "regression",
      "description": "What's wrong",
      "suggestedFix": "How to fix it"
    }
  ],
  "newTasks": [
    {
      "description": "What needs to be done",
      "files": ["files/to/modify.ts"],
      "priority": 1,
      "reason": "Why this task is needed"
    }
  ]
}

Note: Use "issues" for quick fixes that original workers can handle.
Use "newTasks" for larger work that needs a dedicated worker (e.g., new features, architectural changes, security fixes).`;

	const agentsWithOverride = config.model
		? agents.map(a => a.name === "code-reviewer" ? { ...a, model: config.model } : a)
		: agents;

	const result = await runSingleAgent(
		runtime,
		agentsWithOverride,
		"code-reviewer",
		task,
		runtime.cwd,
		undefined,
		signal,
		undefined,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
		{ outputLimits: config.outputLimits, artifactsDir: path.join(coordDir, "artifacts"), artifactLabel: "review" },
	);

	let output = getResultOutput(result);
	if (result.truncated && result.artifactPaths?.outputPath) {
		output = await fs.readFile(result.artifactPaths.outputPath, "utf-8").catch(() => output);
	}
	let parsed: { allPassing: boolean; summary: string; issues: Partial<ReviewIssue>[]; newTasks?: NewTaskRequest[] };
	
	try {
		const jsonMatch = output.match(/\{[\s\S]*\}/);
		parsed = JSON.parse(jsonMatch?.[0] || output);
	} catch {
		parsed = {
			allPassing: false,
			summary: "Failed to parse review output",
			issues: [],
		};
	}

	const issues = (parsed.issues || []).map((i) => ({
		id: randomUUID(),
		file: i.file || "unknown",
		line: i.line,
		severity: i.severity || "warning",
		category: i.category || "bug",
		description: i.description || "",
		suggestedFix: i.suggestedFix,
		fixAttempts: 0,
	})) as ReviewIssue[];

	// Validate newTasks format
	const newTasks = (parsed.newTasks || []).filter(t => 
		t.description && typeof t.description === "string" &&
		t.reason && typeof t.reason === "string"
	);

	return {
		issues,
		summary: parsed.summary || "",
		allPassing: parsed.allPassing ?? issues.length === 0,
		filesReviewed: modifiedFiles,
		duration: Date.now() - startTime,
		cost: result.usage.cost,
		newTasks: newTasks.length > 0 ? newTasks : undefined,
	};
}
