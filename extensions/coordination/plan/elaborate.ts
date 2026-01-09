/**
 * Elaborate Phase - Frontier model expands into a detailed plan.
 *
 * The elaborate phase receives ~100K tokens of context directly in its prompt:
 * - metaPrompt (~15K) - Synthesized guidance from scout
 * - contextDoc (~85K) - Raw file contents from scout
 * - Interview transcript (~1-5K)
 *
 * NO TOOL CALLS - the model just thinks and produces a detailed plan.
 * Output: 1000-3000 word detailed implementation plan.
 *
 * @module
 */

import type { AgentRuntime } from "../subagent/runner.js";
import { discoverAgents } from "../subagent/agents.js";
import { runSingleAgent } from "../subagent/runner.js";
import type { InterviewResult } from "./interview.js";
import type { ScoutResult } from "./scout-targeted.js";

/**
 * Elaborate configuration.
 */
export interface ElaborateConfig {
	/** Model for elaboration (should be frontier model) */
	model?: string;
	/** Mode: "new" creates fresh plan, "refine" modifies existing */
	mode?: "new" | "refine";
	/** Abort signal */
	signal?: AbortSignal;
}

/**
 * Result from elaborate phase.
 */
export interface ElaborateResult {
	/** Detailed plan text (1000-3000 words) */
	plan: string;
	/** LLM cost */
	cost: number;
	/** Input tokens consumed */
	inputTokens: number;
	/** Output tokens generated */
	outputTokens: number;
	/** Duration in ms */
	duration: number;
}

/**
 * Build the elaborate prompt with all context injected.
 */
function buildElaboratePrompt(
	input: string,
	interviewResult: InterviewResult,
	scoutResult: ScoutResult,
	mode: "new" | "refine",
): string {
	const interviewSection = interviewResult.totalRounds > 0
		? interviewResult.transcript
		: "(No interview conducted)";

	const modeInstructions = mode === "refine"
		? `
Refine the existing plan based on new information from the interview.
- Keep what's still valid
- Update what needs to change
- Add any newly discovered requirements
`
		: `
Create a comprehensive implementation plan that:
- Follows the patterns identified in the codebase
- Respects the dependency order suggested
- Addresses all interview requirements
- Stays within the scope constraints
`;

	return `You are an expert software architect creating a detailed implementation plan.
You have been given complete codebase context - DO NOT ask for more files.

═══════════════════════════════════════════════════════════════════════════════
PLANNING GUIDANCE (from codebase analysis)
═══════════════════════════════════════════════════════════════════════════════

${scoutResult.metaPrompt}

═══════════════════════════════════════════════════════════════════════════════
ORIGINAL REQUEST
═══════════════════════════════════════════════════════════════════════════════

${input}

═══════════════════════════════════════════════════════════════════════════════
INTERVIEW FINDINGS
═══════════════════════════════════════════════════════════════════════════════

${interviewSection}

═══════════════════════════════════════════════════════════════════════════════
CODEBASE CONTEXT (${scoutResult.tokenMetrics.contextTokens.toLocaleString()} tokens)
═══════════════════════════════════════════════════════════════════════════════

${scoutResult.contextDoc}

═══════════════════════════════════════════════════════════════════════════════
YOUR TASK
═══════════════════════════════════════════════════════════════════════════════
${modeInstructions}

## Output Format

Produce a detailed plan with these sections:

1. **Summary** - What we're building and why (2-3 sentences)

2. **Technical Approach** - How it integrates with existing code
   - Architecture decisions and rationale
   - Key integration points
   - Dependencies and imports

3. **Implementation Steps** - Detailed breakdown with reasoning
   - Each step should reference specific files
   - Include what to create, modify, or delete
   - Note any ordering dependencies

4. **Edge Cases** - What could go wrong and how to handle it
   - Error scenarios
   - Race conditions
   - Validation requirements

5. **Testing Strategy** - How to verify correctness
   - Unit tests needed
   - Integration tests
   - Manual verification steps

6. **Assumptions** - What we're assuming to be true
   - Technical assumptions
   - Scope boundaries
   - Things explicitly NOT included

Target 1000-3000 words. Be specific - reference actual files and line numbers from the codebase context.
Do NOT use placeholders like "implement X here" - provide concrete implementation details.`;
}

/**
 * Run the elaborate phase to create a detailed plan.
 */
export async function elaborate(
	runtime: AgentRuntime,
	input: string,
	interviewResult: InterviewResult,
	scoutResult: ScoutResult,
	config: ElaborateConfig = {},
): Promise<ElaborateResult> {
	const startTime = Date.now();
	const { model, mode = "new", signal } = config;

	const { agents } = discoverAgents(runtime.cwd, "user");

	// Build the full prompt with all context (~100K tokens)
	const prompt = buildElaboratePrompt(input, interviewResult, scoutResult, mode);

	// Use planner agent for elaboration (it should have a frontier model)
	// The key difference: we pass tools: [] to disable tool usage
	const agentName = "coordination/planner";
	const agentExists = agents.some((a) => a.name === agentName);

	if (!agentExists) {
		// Return a basic plan structure if agent not found
		return {
			plan: generateFallbackPlan(input, interviewResult, scoutResult),
			cost: 0,
			inputTokens: 0,
			outputTokens: 0,
			duration: Date.now() - startTime,
		};
	}

	// Override agent to use specified model and NO tools
	const elaborateAgents = agents.map((a) => {
		if (a.name === agentName) {
			return {
				...a,
				model: model || a.model,
				tools: [], // NO TOOLS - purely analytical
				systemPromptMode: "override" as const,
				systemPrompt: `You are an expert software architect. Analyze the provided context and create a detailed implementation plan. DO NOT use any tools - just think and write.`,
			};
		}
		return a;
	});

	const result = await runSingleAgent(
		runtime,
		elaborateAgents,
		agentName,
		prompt,
		runtime.cwd,
		undefined,
		signal,
		undefined,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
	);

	const plan = extractTextFromResult(result);

	return {
		plan: plan || generateFallbackPlan(input, interviewResult, scoutResult),
		cost: result.usage.cost,
		inputTokens: result.usage.input + result.usage.cacheRead,
		outputTokens: result.usage.output,
		duration: Date.now() - startTime,
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

function generateFallbackPlan(
	input: string,
	interviewResult: InterviewResult,
	scoutResult: ScoutResult,
): string {
	const filesToModify = scoutResult.keyFiles
		.filter((f) => f.relevance === "modify")
		.map((f) => `- ${f.path}`)
		.join("\n") || "- (analyze codebase to determine)";

	const interviewNotes = interviewResult.totalRounds > 0
		? `\n\n### Interview Notes\n${interviewResult.transcript}`
		: "";

	return `# Implementation Plan

## Summary
${input}
${interviewNotes}

## Technical Approach
Review the codebase and follow existing patterns.

## Implementation Steps

### Step 1: Analyze existing code
Review the following files:
${filesToModify}

### Step 2: Implement changes
Create or modify files as needed.

### Step 3: Write tests
Add unit tests for new functionality.

### Step 4: Integration testing
Verify the changes work with existing code.

## Edge Cases
- Consider error handling
- Validate inputs
- Handle edge cases

## Testing Strategy
- Unit tests for new functions
- Integration tests for modified modules
- Manual verification

## Assumptions
- Following existing code patterns
- No breaking changes to public APIs

---
*Note: This is a fallback plan. Run with proper agent configuration for detailed analysis.*
`;
}
