import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runSingleAgent } from "../../subagent/runner.js";
import { discoverAgents } from "../../subagent/agents.js";
import type { CustomToolAPI } from "@mariozechner/pi-coding-agent";

export interface ScoutConfig {
	depth: "shallow" | "deep";
	outputDir: string;
	maxFileSize: number;
	model?: string;
}

export interface ScoutResult {
	contextDoc: string;
	supplementaryFiles: string[];
	keyFiles: { path: string; snippets: { lines: string; content: string }[] }[];
	duration: number;
	cost: number;
}

export async function runScoutPhase(
	pi: CustomToolAPI,
	_planPath: string,
	planContent: string,
	_coordDir: string,
	config: ScoutConfig,
	signal?: AbortSignal,
): Promise<ScoutResult> {
	const startTime = Date.now();
	const { agents } = discoverAgents(pi.cwd, "user");

	await fs.mkdir(config.outputDir, { recursive: true });

	const task = `Analyze this implementation plan and the codebase to provide context for workers.

## Plan
${planContent}

## Output Requirements
1. Main context document with architecture overview
2. Key code snippets with file:line references for workers to reference
3. File ownership suggestions (which files naturally group together)
4. Patterns that workers should follow

Save detailed output to: ${config.outputDir}/

### Output Structure
- Save \`main.md\` - Primary context document with overview
- Save \`files/<name>.md\` - Detailed snippets for key files (if main.md would be too large)
- Include actual code, not summaries`;

	const agentsWithOverride = config.model 
		? agents.map(a => a.name === "scout" ? { ...a, model: config.model } : a)
		: agents;

	const result = await runSingleAgent(
		pi,
		agentsWithOverride,
		"scout",
		task,
		pi.cwd,
		undefined,
		signal,
		undefined,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
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
