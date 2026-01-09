/**
 * Structure Phase - Convert elaborated plan to TASK-XX spec format.
 *
 * Takes the detailed plan from elaborate phase and converts it into
 * the structured TASK-XX format that coordinate tool expects.
 *
 * @module
 */

import type { AgentRuntime } from "../subagent/runner.js";
import { discoverAgents } from "../subagent/agents.js";
import { runSingleAgent } from "../subagent/runner.js";
import { parseSpec, type Spec } from "../coordinate/spec-parser.js";
import { validateSpec, formatValidationResult } from "../coordinate/spec-validator.js";

/**
 * Structure configuration.
 */
export interface StructureConfig {
	/** Model for structuring */
	model?: string;
	/** Abort signal */
	signal?: AbortSignal;
	/** Maximum retries for validation failures */
	maxRetries?: number;
}

/**
 * Result from structure phase.
 */
export interface StructureResult {
	/** Parsed spec */
	spec: Spec;
	/** Raw markdown output */
	specMarkdown: string;
	/** LLM cost */
	cost: number;
	/** Duration in ms */
	duration: number;
	/** Number of validation retries needed */
	retries: number;
	/** Any validation warnings */
	warnings: string[];
}

/**
 * Convert an elaborated plan into TASK-XX spec format.
 */
export async function structureTasks(
	runtime: AgentRuntime,
	elaboratedPlan: string,
	originalInput: string,
	config: StructureConfig = {},
): Promise<StructureResult> {
	const startTime = Date.now();
	const { model, signal, maxRetries = 2 } = config;

	const { agents } = discoverAgents(runtime.cwd, "user");

	let totalCost = 0;
	let retries = 0;
	let lastOutput = "";
	let lastValidation: ReturnType<typeof validateSpec> | null = null;

	const basePrompt = `Convert this detailed plan into a structured task spec.

## Plan
${elaboratedPlan}

## Output Format

Create a markdown spec with TASK-XX format. Each task must have:
- \`## TASK-XX: [Title]\` - Header with unique ID (TASK-01, TASK-02, etc.)
- \`Priority: P0|P1|P2|P3\` - P0 highest, P3 lowest
- \`Files: [files]\` - Files with (create), (modify), or (delete) annotations
- \`Depends on: [task IDs or "none"]\` - Dependencies
- \`Acceptance: [criteria]\` - Testable acceptance criteria

Optional: Description paragraphs below the fields.

## Example

\`\`\`markdown
# Add Authentication

Implement JWT-based authentication for the API.

---

## TASK-01: Create auth types
Priority: P1
Files: src/auth/types.ts (create)
Depends on: none
Acceptance: Exports User, Token, and Session interfaces

Define TypeScript interfaces for authentication.

## TASK-02: Implement JWT utilities
Priority: P1
Files: src/auth/jwt.ts (create), src/auth/types.ts (modify)
Depends on: TASK-01
Acceptance: sign() and verify() functions work correctly

Create utility functions for JWT operations.

## TASK-03: Add auth middleware
Priority: P2
Files: src/middleware/auth.ts (create)
Depends on: TASK-02
Acceptance: Middleware validates JWT and sets req.user
\`\`\`

## Rules

1. **Task IDs**: Use TASK-XX format (TASK-01, TASK-02, etc.)
2. **At least one entry point**: One task MUST have \`Depends on: none\`
3. **Valid dependencies**: Only reference existing task IDs
4. **No circular dependencies**: A → B → A is not allowed
5. **Atomic tasks**: Each task should be completable in one focused session
6. **Priority guidelines**:
   - P0: Critical path blockers
   - P1: Important, high value
   - P2: Standard tasks (use for most)
   - P3: Nice-to-have, low priority
7. **File annotations**: (create), (modify), (delete)
8. **Testable acceptance**: Each acceptance criterion should be verifiable

Output ONLY the markdown spec, no explanation.`;

	// Try to generate valid spec, with retries on validation failure
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		let prompt = basePrompt;

		// Add validation feedback for retries
		if (attempt > 0 && lastValidation) {
			const feedback = formatValidationResult(lastValidation);
			prompt = `${basePrompt}

## ⚠️ VALIDATION FEEDBACK (Attempt ${attempt + 1})

Your previous output had errors. Please fix them:

${feedback}

Previous output:
\`\`\`markdown
${lastOutput}
\`\`\`

Fix the errors above and output a VALID spec.`;
		}

		const agentName = "coordination/planner";
		const agentExists = agents.some((a) => a.name === agentName);

		if (!agentExists) {
			// Generate a basic spec without LLM
			return generateFallbackSpec(originalInput, elaboratedPlan, startTime);
		}

		// Override to use specified model and no tools
		const structureAgents = agents.map((a) => {
			if (a.name === agentName) {
				return {
					...a,
					model: model || a.model,
					tools: [], // No tools needed for structuring
					systemPromptMode: "override" as const,
					systemPrompt: `You are a task specification expert. Convert plans into structured TASK-XX format. Output ONLY valid markdown.`,
				};
			}
			return a;
		});

		const result = await runSingleAgent(
			runtime,
			structureAgents,
			agentName,
			prompt,
			runtime.cwd,
			undefined,
			signal,
			undefined,
			(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
		);

		totalCost += result.usage.cost;
		lastOutput = extractTextFromResult(result);

		// Parse and validate
		const spec = parseSpec(lastOutput);

		// Add title if missing
		if (!spec.title && originalInput) {
			spec.title = extractTitle(originalInput);
		}

		lastValidation = validateSpec(spec);

		if (lastValidation.valid) {
			return {
				spec,
				specMarkdown: lastOutput,
				cost: totalCost,
				duration: Date.now() - startTime,
				retries,
				warnings: lastValidation.warnings.map((w) => w.message),
			};
		}

		retries++;
	}

	// Max retries exceeded - return what we have with warnings
	const finalSpec = parseSpec(lastOutput);
	if (!finalSpec.title && originalInput) {
		finalSpec.title = extractTitle(originalInput);
	}

	return {
		spec: finalSpec,
		specMarkdown: lastOutput,
		cost: totalCost,
		duration: Date.now() - startTime,
		retries,
		warnings: [
			`Validation failed after ${maxRetries} retries`,
			...(lastValidation?.errors.map((e) => e.message) || []),
			...(lastValidation?.warnings.map((w) => w.message) || []),
		],
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

function extractTitle(input: string): string {
	// Extract title from first line or first sentence
	const firstLine = input.split("\n")[0].trim();
	if (firstLine.startsWith("#")) {
		return firstLine.replace(/^#+\s*/, "").trim();
	}
	// Use first 50 chars or first sentence
	const firstSentence = input.split(/[.!?]/)[0].trim();
	if (firstSentence.length <= 60) {
		return firstSentence;
	}
	return firstSentence.slice(0, 57) + "...";
}

function generateFallbackSpec(
	originalInput: string,
	elaboratedPlan: string,
	startTime: number,
): StructureResult {
	const title = extractTitle(originalInput);

	const specMarkdown = `# ${title}

${originalInput}

---

## TASK-01: Implement changes
Priority: P1
Files: (analyze codebase to determine)
Depends on: none
Acceptance: Implementation complete as described

${elaboratedPlan}

---

*Note: This is a fallback spec. Run with proper agent configuration for detailed task breakdown.*
`;

	const spec = parseSpec(specMarkdown);

	return {
		spec,
		specMarkdown,
		cost: 0,
		duration: Date.now() - startTime,
		retries: 0,
		warnings: ["Generated fallback spec - planner agent not found"],
	};
}
