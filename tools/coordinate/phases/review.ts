import { exec } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { runSingleAgent } from "../../subagent/runner.js";
import { discoverAgents } from "../../subagent/agents.js";
import { getFinalOutput } from "../../subagent/render.js";
import type { ReviewIssue, WorkerStateFile } from "../types.js";
import type { CustomToolAPI } from "@mariozechner/pi-coding-agent";

const execAsync = promisify(exec);

export interface ReviewConfig {
	model?: string;
	checkTests: boolean;
	verifyPlanGoals: boolean;
}

export interface ReviewResult {
	issues: ReviewIssue[];
	summary: string;
	allPassing: boolean;
	filesReviewed: string[];
	duration: number;
	cost: number;
}

export async function runReviewPhase(
	pi: CustomToolAPI,
	_coordDir: string,
	planContent: string,
	workerStates: WorkerStateFile[],
	config: ReviewConfig,
	signal?: AbortSignal,
): Promise<ReviewResult> {
	const startTime = Date.now();
	const { agents } = discoverAgents(pi.cwd, "user");

	const modifiedFiles = [...new Set(workerStates.flatMap(w => w.filesModified))];
	
	let gitDiff = "";
	if (modifiedFiles.length > 0) {
		try {
			const quotedFiles = modifiedFiles.map(f => `"${f.replace(/"/g, '\\"')}"`).join(" ");
			const { stdout } = await execAsync(`git diff HEAD -- ${quotedFiles}`, { cwd: pi.cwd });
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
  ]
}`;

	const agentsWithOverride = config.model
		? agents.map(a => a.name === "code-reviewer" ? { ...a, model: config.model } : a)
		: agents;

	const result = await runSingleAgent(
		pi,
		agentsWithOverride,
		"code-reviewer",
		task,
		pi.cwd,
		undefined,
		signal,
		undefined,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
	);

	const output = getFinalOutput(result.messages);
	let parsed: { allPassing: boolean; summary: string; issues: Partial<ReviewIssue>[] };
	
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

	return {
		issues,
		summary: parsed.summary || "",
		allPassing: parsed.allPassing ?? issues.length === 0,
		filesReviewed: modifiedFiles,
		duration: Date.now() - startTime,
		cost: result.usage.cost,
	};
}
