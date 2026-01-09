/**
 * Targeted Scout Module - Generates context for the elaborate phase.
 *
 * The scout reads codebase files based on interview findings and produces:
 * 1. contextDoc (~85K tokens) - Raw file contents with structure
 * 2. metaPrompt (~15K tokens) - Synthesized guidance for the planner
 *
 * These are passed directly to the elaborate phase (~100K total context).
 *
 * @module
 */

import * as path from "node:path";
import type { AgentRuntime } from "../subagent/runner.js";
import { discoverAgents } from "../subagent/agents.js";
import { runSingleAgent } from "../subagent/runner.js";
import type { InterviewResult } from "./interview.js";

/**
 * Key file identified by scout.
 */
export interface KeyFile {
	/** File path */
	path: string;
	/** Relevance type */
	relevance: "modify" | "reference" | "pattern";
	/** File snippets included */
	snippets: Array<{ lines: string; content: string }>;
}

/**
 * Token metrics for context generation.
 */
export interface TokenMetrics {
	/** Tokens in contextDoc */
	contextTokens: number;
	/** Tokens in metaPrompt */
	metaTokens: number;
	/** Combined total */
	totalTokens: number;
	/** Configured budget */
	budget: number;
	/** Path to overflow content if budget exceeded */
	overflowPath?: string;
}

/**
 * Scout configuration.
 */
export interface ScoutConfig {
	/** Model for scout agent */
	model?: string;
	/** Working directory */
	cwd: string;
	/** Total token budget (default: 100_000) */
	tokenBudget?: number;
	/** Portion for contextDoc vs metaPrompt (default: 0.85) */
	contextRatio?: number;
	/** Abort signal */
	signal?: AbortSignal;
	/** Progress callback */
	onProgress?: (update: { phase: string; filesScanned?: number }) => void;
}

/**
 * Result from running targeted scout.
 */
export interface ScoutResult {
	/** Raw file contents with structure */
	contextDoc: string;
	/** Synthesized guidance for planner */
	metaPrompt: string;
	/** Parsed file info */
	keyFiles: KeyFile[];
	/** Token usage metrics */
	tokenMetrics: TokenMetrics;
	/** Duration in ms */
	duration: number;
	/** LLM cost */
	cost: number;
}

/**
 * Run targeted scout to gather codebase context.
 */
export async function runTargetedScout(
	runtime: AgentRuntime,
	input: string,
	interviewResult: InterviewResult,
	config: ScoutConfig,
): Promise<ScoutResult> {
	const startTime = Date.now();
	const {
		model,
		cwd,
		tokenBudget = 100_000,
		contextRatio = 0.85,
		signal,
		onProgress,
	} = config;

	const contextBudget = Math.floor(tokenBudget * contextRatio);
	const metaBudget = tokenBudget - contextBudget;

	let totalCost = 0;
	const keyFiles: KeyFile[] = [];

	// Phase 1: Generate contextDoc (file contents)
	onProgress?.({ phase: "scanning", filesScanned: 0 });

	const { contextDoc, contextTokens, contextCost, files } = await generateContextDoc(
		runtime,
		input,
		interviewResult,
		{ model, cwd, tokenBudget: contextBudget, signal },
	);
	totalCost += contextCost;
	keyFiles.push(...files);

	onProgress?.({ phase: "analyzing", filesScanned: files.length });

	// Phase 2: Generate metaPrompt (synthesized guidance)
	const { metaPrompt, metaTokens, metaCost } = await generateMetaPrompt(
		runtime,
		input,
		interviewResult,
		contextDoc,
		{ model, cwd, tokenBudget: metaBudget, signal },
	);
	totalCost += metaCost;

	return {
		contextDoc,
		metaPrompt,
		keyFiles,
		tokenMetrics: {
			contextTokens,
			metaTokens,
			totalTokens: contextTokens + metaTokens,
			budget: tokenBudget,
		},
		duration: Date.now() - startTime,
		cost: totalCost,
	};
}

/**
 * Generate contextDoc with file contents.
 */
async function generateContextDoc(
	runtime: AgentRuntime,
	input: string,
	interviewResult: InterviewResult,
	config: { model?: string; cwd: string; tokenBudget: number; signal?: AbortSignal },
): Promise<{
	contextDoc: string;
	contextTokens: number;
	contextCost: number;
	files: KeyFile[];
}> {
	const { agents } = discoverAgents(runtime.cwd, "user");

	const interviewSection = interviewResult.transcript
		? `\n\n## Interview Findings\n${interviewResult.transcript}`
		: "";

	const task = `You are a codebase analyst. Read files and produce a context document for planning.

## Request
${input}
${interviewSection}

## Instructions

1. Use the \`find\`, \`grep\`, and \`read\` tools to explore the codebase
2. Focus on files relevant to this request
3. Include file contents that the planner will need

## Output Format

Produce a markdown document with these sections:

\`\`\`markdown
<file_map>
/path/to/project
├── src
│   ├── types.ts        * +    (* = needs modification, + = contents included)
│   ├── store.ts        * +
│   └── routes/
│       └── index.ts      +    (reference only)
</file_map>

<file_contents>
File: src/types.ts (full file - 45 lines)
\`\`\`typescript
// file content here
\`\`\`

File: src/routes/index.ts:1-30 (partial)
\`\`\`typescript
// relevant section
\`\`\`
</file_contents>
\`\`\`

## Rules
- Include files that will be modified (* marker)
- Include reference files for patterns and imports
- For large files, include only relevant sections with line numbers
- Target ~${Math.floor(config.tokenBudget / 4)} tokens (${Math.floor(config.tokenBudget / 100)} lines max)
- Prioritize: types/interfaces > implementation > tests > docs`;

	const agentName = "coordination/scout";
	const agentExists = agents.some((a) => a.name === agentName);

	if (!agentExists) {
		// Return empty context if scout agent not found
		return {
			contextDoc: "<file_map>\n(Scout agent not found)\n</file_map>\n\n<file_contents>\n</file_contents>",
			contextTokens: 50,
			contextCost: 0,
			files: [],
		};
	}

	const agentsWithModel = config.model
		? agents.map((a) => (a.name === agentName ? { ...a, model: config.model } : a))
		: agents;

	const result = await runSingleAgent(
		runtime,
		agentsWithModel,
		agentName,
		task,
		config.cwd,
		undefined,
		config.signal,
		undefined,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
	);

	const output = extractTextFromResult(result);
	const files = parseFilesFromContextDoc(output);

	// Estimate token count (rough: 4 chars per token)
	const contextTokens = Math.ceil(output.length / 4);

	return {
		contextDoc: output || generateEmptyContextDoc(),
		contextTokens,
		contextCost: result.usage.cost,
		files,
	};
}

/**
 * Generate metaPrompt with synthesized guidance.
 */
async function generateMetaPrompt(
	runtime: AgentRuntime,
	input: string,
	interviewResult: InterviewResult,
	contextDoc: string,
	config: { model?: string; cwd: string; tokenBudget: number; signal?: AbortSignal },
): Promise<{
	metaPrompt: string;
	metaTokens: number;
	metaCost: number;
}> {
	const { agents } = discoverAgents(runtime.cwd, "user");

	const interviewSection = interviewResult.transcript
		? `\n\n## Interview Findings\n${interviewResult.transcript}`
		: "";

	const task = `Analyze the codebase context and produce planning guidance.

## Original Request
${input}
${interviewSection}

## Codebase Context
${contextDoc}

## Instructions

Synthesize the codebase analysis into actionable planning guidance.

## Output Format

\`\`\`markdown
# Planning Guidance

## Request Summary
[1-2 sentences summarizing what to build and key requirements from interview]

## Architecture Analysis

### Current State
[Brief description of existing architecture]

### Integration Points
| What | Where | Action |
|------|-------|--------|
| [Type/module] | [File path] | [create/modify/reference] |

### Patterns to Follow
[Reference existing patterns in the codebase]

### Dependency Order
[Numbered list of logical task order]

### Parallelization Opportunities
[Which tasks can run in parallel]

### Gotchas & Warnings
[Things to watch out for]

### Scope Constraints
[What to include and explicitly exclude]

### Recommended Task Breakdown
[Suggested tasks with time estimates]
\`\`\`

## Rules
- Be specific - reference actual file paths and line numbers
- Include concrete code patterns from the codebase
- Note any legacy code to avoid or deprecate
- Target ~${Math.floor(config.tokenBudget / 4)} tokens`;

	const agentName = "coordination/scout";
	const agentExists = agents.some((a) => a.name === agentName);

	if (!agentExists) {
		return {
			metaPrompt: generateDefaultMetaPrompt(input, interviewResult),
			metaTokens: 200,
			metaCost: 0,
		};
	}

	const agentsWithModel = config.model
		? agents.map((a) => (a.name === agentName ? { ...a, model: config.model } : a))
		: agents;

	const result = await runSingleAgent(
		runtime,
		agentsWithModel,
		agentName,
		task,
		config.cwd,
		undefined,
		config.signal,
		undefined,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
	);

	const output = extractTextFromResult(result);
	const metaTokens = Math.ceil(output.length / 4);

	return {
		metaPrompt: output || generateDefaultMetaPrompt(input, interviewResult),
		metaTokens,
		metaCost: result.usage.cost,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function extractTextFromResult(result: {
	messages?: Array<{ role: string; content: unknown }>;
}): string {
	if (!result.messages) return "";

	for (let i = result.messages.length - 1; i >= 0; i--) {
		const msg = result.messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const textBlocks = msg.content.filter(
				(b: unknown) =>
					typeof b === "object" && b !== null && (b as { type: string }).type === "text",
			);
			return textBlocks.map((b: { text?: string }) => b.text || "").join("\n");
		}
	}

	return "";
}

function parseFilesFromContextDoc(contextDoc: string): KeyFile[] {
	const files: KeyFile[] = [];

	// Extract from <file_contents> section
	const fileContentsMatch = contextDoc.match(/<file_contents>([\s\S]*?)<\/file_contents>/);
	if (!fileContentsMatch) return files;

	const content = fileContentsMatch[1];
	const fileMatches = content.matchAll(/File:\s*([^\s(]+)(?:\s*\(([^)]+)\))?/g);

	for (const match of fileMatches) {
		const filePath = match[1];
		const meta = match[2] || "";

		// Determine relevance based on file_map markers
		let relevance: "modify" | "reference" | "pattern" = "reference";
		if (contextDoc.includes(`${path.basename(filePath)}        * +`) ||
		    contextDoc.includes(`${path.basename(filePath)}    * +`)) {
			relevance = "modify";
		} else if (meta.includes("pattern")) {
			relevance = "pattern";
		}

		files.push({
			path: filePath,
			relevance,
			snippets: [], // Could parse snippets but not needed for this implementation
		});
	}

	return files;
}

function generateEmptyContextDoc(): string {
	return `<file_map>
(No files scanned - scout phase skipped or failed)
</file_map>

<file_contents>
</file_contents>`;
}

function generateDefaultMetaPrompt(
	input: string,
	interviewResult: InterviewResult,
): string {
	const interviewSection = interviewResult.totalRounds > 0
		? `\n\n## Interview Findings\n${interviewResult.transcript}`
		: "";

	return `# Planning Guidance

## Request Summary
${input}
${interviewSection}

## Architecture Analysis

### Current State
(Codebase analysis not available - scout phase skipped or failed)

### Integration Points
| What | Where | Action |
|------|-------|--------|
| (analyze codebase to determine) | | |

### Patterns to Follow
Review existing code patterns before implementing.

### Dependency Order
1. Start with types/interfaces
2. Implement core logic
3. Add integration code
4. Write tests

### Gotchas & Warnings
- Review existing code before making changes
- Follow established patterns in the codebase
- Consider backward compatibility

### Scope Constraints
Implement only what was explicitly requested.
`;
}
