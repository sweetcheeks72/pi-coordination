import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runSingleAgent, type AgentRuntime } from "../../subagent/runner.js";
import { discoverAgents } from "../../subagent/agents.js";
import type { OutputLimits } from "../../subagent/types.js";

export interface ScoutConfig {
	depth: "shallow" | "deep";
	outputDir: string;
	maxFileSize: number;
	model?: string;
	outputLimits?: OutputLimits;
	tokenBudget?: number;
	agentName?: string;
}

export interface ScoutResult {
	contextDoc: string;
	supplementaryFiles: string[];
	keyFiles: { path: string; snippets: { lines: string; content: string }[] }[];
	duration: number;
	cost: number;
}

export async function runScoutPhase(
	runtime: AgentRuntime,
	_planPath: string,
	planContent: string,
	coordDir: string,
	config: ScoutConfig,
	signal?: AbortSignal,
): Promise<ScoutResult> {
	const startTime = Date.now();
	const { agents } = discoverAgents(runtime.cwd, "user");

	await fs.mkdir(config.outputDir, { recursive: true });

	const tokenBudget = config.tokenBudget || 30000;

	const task = `Analyze this implementation plan and the codebase to provide context for PLANNING task breakdown.

## Plan
${planContent}

## Output Requirements
1. Architecture overview relevant to the plan
2. Key files that will need modification (with actual code snippets)
3. Dependencies between components
4. Existing patterns to follow
5. Potential risks or complexities

## Token Budget
Target ~${tokenBudget} tokens for main.md. Prioritize:
- Most relevant code sections for the plan
- Interface definitions and types
- Key function signatures
- Example usage patterns

Save detailed output to: ${config.outputDir}/

### Output Structure
- Save \`main.md\` - Primary context document (token-budgeted)
- Save \`files/<name>.md\` - Detailed snippets for key files (if main.md would be too large)
- Include actual code, not summaries`;

	const agentName = config.agentName || "coordination/scout";
	const agentsWithOverride = config.model 
		? agents.map(a => a.name === agentName ? { ...a, model: config.model } : a)
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
		{ outputLimits: config.outputLimits, artifactsDir: path.join(coordDir, "artifacts"), artifactLabel: "scout" },
	);

	const contextPath = path.join(config.outputDir, "main.md");
	const contextDoc = await fs.readFile(contextPath, "utf-8").catch(() => "");

	return {
		contextDoc,
		supplementaryFiles: await listSupplementaryFiles(config.outputDir),
		keyFiles: parseKeyFiles(contextDoc),
		duration: Date.now() - startTime,
		cost: result.usage.cost,
	};
}

async function listSupplementaryFiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
		return entries
			.filter(e => e.isFile() && e.name.endsWith(".md") && e.name !== "main.md")
			.map(e => path.join(e.parentPath || e.path, e.name));
	} catch {
		return [];
	}
}

function parseKeyFiles(contextDoc: string): { path: string; snippets: { lines: string; content: string }[] }[] {
	const keyFiles: { path: string; snippets: { lines: string; content: string }[] }[] = [];
	const fileRegex = /From `([^`]+)`:(\d+-\d+)/g;
	let match;
	while ((match = fileRegex.exec(contextDoc)) !== null) {
		const [, filePath, lines] = match;
		const existing = keyFiles.find(f => f.path === filePath);
		if (existing) {
			existing.snippets.push({ lines, content: "" });
		} else {
			keyFiles.push({ path: filePath, snippets: [{ lines, content: "" }] });
		}
	}
	return keyFiles;
}
