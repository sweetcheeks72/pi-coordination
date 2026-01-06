import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runSingleAgent, type AgentRuntime } from "../../subagent/runner.js";
import { discoverAgents } from "../../subagent/agents.js";
import type { OutputLimits } from "../../subagent/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

	const tokenBudget = config.tokenBudget || 100000;

	const task = `Analyze this implementation plan and the codebase to provide context for PLANNING task breakdown.

## Plan
${planContent}

## Instructions

1. Use \`scan_files()\` to see the codebase structure with token counts
2. Identify files relevant to this plan:
   - Files that need modification
   - Type definitions and interfaces
   - Pattern examples workers should follow
   - Configuration files
3. Use \`bundle_files({ files: [...] })\` to get contents (max ${tokenBudget} tokens)
4. Output the result to \`${config.outputDir}/main.md\`

## Output Format

Create \`main.md\` with this structure:

\`\`\`markdown
<file_map>
(tree from scan_files, add * for files to modify, + for files included below)
</file_map>

<file_contents>
(output from bundle_files goes here)
</file_contents>
\`\`\`

The \`bundle_files\` output is already formatted - just wrap it in the \`<file_contents>\` tags.`;

	const agentName = config.agentName || "coordination/scout";
	const agentsWithOverride = config.model 
		? agents.map(a => a.name === agentName ? { ...a, model: config.model } : a)
		: agents;

	const scoutExtensionPath = path.resolve(__dirname, "..", "..", "..", "extensions", "coordination", "scout.ts");

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
		{ outputLimits: config.outputLimits, artifactsDir: path.join(coordDir, "artifacts"), artifactLabel: "scout", extensions: [scoutExtensionPath] },
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
