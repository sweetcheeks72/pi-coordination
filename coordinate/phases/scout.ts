import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runSingleAgent, type AgentRuntime } from "../../subagent/runner.js";
import { discoverAgents } from "../../subagent/agents.js";
import type { OnUpdateCallback, OutputLimits } from "../../subagent/types.js";

export interface ScoutConfig {
	depth: "shallow" | "deep";
	outputDir: string;
	maxFileSize: number;
	model?: string;
	outputLimits?: OutputLimits;
	tokenBudget?: number;
	agentName?: string;
	customMetaPrompt?: string; // Path or inline content for custom meta guidance
	onProgress?: OnUpdateCallback; // Stream progress updates
}

export interface ScoutResult {
	contextDoc: string;
	supplementaryFiles: string[];
	keyFiles: { path: string; snippets: { lines: string; content: string }[] }[];
	duration: number;
	cost: number;
	tokenMetrics?: {
		estimated: number;
		budget: number;
		overflowPath?: string;
	};
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

## Output Format

Output a single file \`main.md\` with THREE sections:

### 1. Meta Section (Your Analysis)

\`\`\`markdown
<meta>
<architecture>
[How is the codebase organized? Package structure? Entry points?]
</architecture>

<patterns>
[Code patterns to follow. Naming conventions. Error handling.]
</patterns>

<key_files>
[Central files many things depend on. Integration points.]
</key_files>

<dependencies>
[What depends on what? Suggested modification order.]
</dependencies>

<gotchas>
[Things that might trip someone up. Deprecated code. Tight coupling.]
</gotchas>

<task_recommendations>
[Suggested task breakdown. What to parallelize vs sequence.]
</task_recommendations>

<scope_constraints>
[Implement EXACTLY what plan specifies. No extras.]
</scope_constraints>

<omitted>
[Files you found but didn't include due to budget - list them here]
</omitted>
</meta>
\`\`\`

### 2. File Map

\`\`\`markdown
<file_map>
/path/to/project
├── src
│   ├── types.ts * +
│   └── store.ts * +
(* = needs modification, + = contents included)
</file_map>
\`\`\`

### 3. File Contents

\`\`\`markdown
<file_contents>
File: src/types.ts:1-45 (interfaces)
\`\`\`ts
export interface User { ... }
\`\`\`

File: src/store.ts:120-165 (function to modify)
\`\`\`ts
export function updateUser(...) { }
\`\`\`
</file_contents>
\`\`\`

## Guidelines

- **Line ranges** (\`file.ts:10-50\`): For large files, include only relevant sections
- **Full file**: Only when small (<100 lines) or entirely relevant
- **Priority**: Files to modify > Types/interfaces > Pattern examples > Config
- **Token budget**: ~${tokenBudget} tokens. Line ranges help fit more files.
${config.customMetaPrompt ? `\n## Custom Meta Guidance\n\n${config.customMetaPrompt}` : ""}
Save output to: ${config.outputDir}/main.md`;

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
		config.onProgress,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
		{ outputLimits: config.outputLimits, artifactsDir: path.join(coordDir, "artifacts"), artifactLabel: "scout", parentModel: config.model },
	);

	const contextPath = path.join(config.outputDir, "main.md");
	let contextDoc = await fs.readFile(contextPath, "utf-8").catch(() => "");

	// Token budget enforcement
	const estimatedTokens = Math.ceil(contextDoc.length / 4);
	let overflowPath: string | undefined;

	if (estimatedTokens > tokenBudget && contextDoc) {
		const split = splitAtTokenBudget(contextDoc, tokenBudget);
		contextDoc = split.main;

		if (split.overflow) {
			overflowPath = path.join(config.outputDir, "overflow.md");
			await fs.writeFile(overflowPath, split.overflow, "utf-8");

			// Append note to main
			// Use relative path in the note (overflow.md is in same directory as main.md)
			contextDoc += `\n\n---\n_Additional context available in: ./overflow.md_\n`;
			await fs.writeFile(contextPath, contextDoc, "utf-8");

			const mainTokens = Math.ceil(contextDoc.length / 4);
			const overflowTokens = Math.ceil(split.overflow.length / 4);
			console.log(`Scout: Split output - main: ~${mainTokens} tokens, overflow: ~${overflowTokens} tokens`);
		}
	}

	// Final token count (may differ from original if split occurred)
	const finalTokens = Math.ceil(contextDoc.length / 4);

	return {
		contextDoc,
		supplementaryFiles: await listSupplementaryFiles(config.outputDir),
		keyFiles: parseKeyFiles(contextDoc),
		duration: Date.now() - startTime,
		cost: result.usage.cost,
		tokenMetrics: {
			estimated: finalTokens,
			budget: tokenBudget,
			overflowPath,
		},
	};
}

function splitAtTokenBudget(content: string, budget: number): { main: string; overflow?: string } {
	const estimatedTokens = Math.ceil(content.length / 4);
	if (estimatedTokens <= budget) {
		return { main: content };
	}

	// Find <file_contents> section - this is what we split
	const fileContentsMatch = content.match(/<file_contents>([\s\S]*)<\/file_contents>/);
	if (!fileContentsMatch) {
		// Can't split without file_contents section, return as-is
		return { main: content };
	}

	const beforeFiles = content.slice(0, fileContentsMatch.index);
	const filesSection = fileContentsMatch[1];
	const afterFiles = content.slice(fileContentsMatch.index! + fileContentsMatch[0].length);

	// Split file blocks - keep priority order (scout already sorted by importance)
	const fileBlocks = filesSection.split(/(?=File:\s)/);
	const baseTokens = Math.ceil((beforeFiles.length + afterFiles.length + 50) / 4); // +50 for tags

	let mainFiles = "";
	let overflowFiles = "";
	let currentTokens = baseTokens;

	for (const block of fileBlocks) {
		if (!block.trim()) continue;
		const blockTokens = Math.ceil(block.length / 4);

		if (currentTokens + blockTokens <= budget) {
			mainFiles += block;
			currentTokens += blockTokens;
		} else {
			overflowFiles += block;
		}
	}

	const main = beforeFiles + "<file_contents>\n" + mainFiles + "</file_contents>" + afterFiles;
	const overflow = overflowFiles.trim()
		? "<file_contents>\n" + overflowFiles + "</file_contents>"
		: undefined;

	return { main, overflow };
}

async function listSupplementaryFiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
		return entries
			.filter(e => e.isFile() && e.name.endsWith(".md") && e.name !== "main.md")
			.map(e => path.join(e.parentPath || (e as any).path, e.name));
	} catch {
		return [];
	}
}

function parseKeyFiles(contextDoc: string): { path: string; snippets: { lines: string; content: string }[] }[] {
	const keyFiles: { path: string; snippets: { lines: string; content: string }[] }[] = [];
	
	// Match: File: path/to/file.ts:10-50 (description) or File: path/to/file.ts (full file)
	const fileRegex = /File:\s*([^\s:]+)(?::(\d+-\d+))?\s*(?:\([^)]*\))?\s*\n```\w*\n([\s\S]*?)```/g;
	let match;
	
	while ((match = fileRegex.exec(contextDoc)) !== null) {
		const [, filePath, lines, content] = match;
		const lineRange = lines || "full";
		const existing = keyFiles.find(f => f.path === filePath);
		
		if (existing) {
			existing.snippets.push({ lines: lineRange, content: content.trim() });
		} else {
			keyFiles.push({ 
				path: filePath, 
				snippets: [{ lines: lineRange, content: content.trim() }] 
			});
		}
	}
	
	return keyFiles;
}
