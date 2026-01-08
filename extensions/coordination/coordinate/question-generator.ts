/**
 * LLM-based question generator for clarifying ambiguous requests
 * Analyzes PRD content and generates relevant questions
 */

import { runSingleAgent, type AgentRuntime } from "../subagent/runner.js";
import { discoverAgents } from "../subagent/agents.js";

export type QuestionType = "select" | "text" | "confirm";

export interface QuestionOption {
	label: string;
	value: string;
}

export interface ClarifyingQuestion {
	id: string;
	question: string;
	type: QuestionType;
	options?: QuestionOption[];
	default?: number | string | boolean;
	context?: string; // Additional context for the question
}

export interface QuestionGeneratorConfig {
	model?: string;
	maxQuestions?: number;
	depth?: "shallow" | "deep"; // shallow = 2-4 quick questions, deep = in-depth exploration
}

export interface QuestionGeneratorResult {
	questions: ClarifyingQuestion[];
	cost: number;
	duration: number;
}

/**
 * Generate clarifying questions for a feature request
 */
export async function generateClarifyingQuestions(
	runtime: AgentRuntime,
	prdContent: string,
	config: QuestionGeneratorConfig = {},
): Promise<QuestionGeneratorResult> {
	const startTime = Date.now();
	const { agents } = discoverAgents(runtime.cwd, "user");
	
	const maxQuestions = config.maxQuestions ?? 12;
	const depth = config.depth ?? "deep";
	
	const depthGuidance = depth === "deep" 
		? `Generate comprehensive, in-depth questions that explore:
- Technical implementation choices and tradeoffs
- Architecture decisions (patterns, structure, dependencies)
- Edge cases and error handling strategies
- Performance considerations
- Security implications
- Testing approach
- UI/UX decisions (if applicable)
- Maintenance and extensibility concerns
- Integration points with existing code

Ask non-obvious, thoughtful questions that a senior engineer would ask during design review.
Aim for 5-10 questions that genuinely probe the design space.`
		: `Generate 2-4 quick questions about the most critical ambiguities.
Focus only on blockers that would significantly change the implementation.`;
	
	const task = `You are a senior technical architect conducting a design review. Analyze this feature request and generate clarifying questions.

<request>
${prdContent}
</request>

${depthGuidance}

Output a JSON array of questions. Return [] if the request is already crystal clear.

Format (both inline and interview formats):
\`\`\`json
[
  {
    "id": "unique_snake_case_id",
    "question": "Thoughtful question that probes a real design decision?",
    "type": "select",
    "options": [
      {"label": "Option A - brief explanation", "value": "option_a"},
      {"label": "Option B - brief explanation", "value": "option_b"},
      {"label": "Other (I'll specify)", "value": "other"}
    ],
    "default": 0,
    "context": "Why this matters: explanation of the tradeoff"
  },
  {
    "id": "implementation_detail",
    "question": "Open-ended question for complex input?",
    "type": "text",
    "default": "",
    "context": "Provide any relevant context, examples, or constraints"
  },
  {
    "id": "boolean_choice",
    "question": "Yes/no question for binary decision?",
    "type": "confirm",
    "default": true,
    "context": "Implication of yes vs no"
  }
]
\`\`\`

Rules:
- Avoid obvious questions ("Should I write tests?" - yes, always)
- Each question should reveal something non-obvious about the design
- Include "context" field explaining why the question matters
- For select: always include an "Other" option for custom input
- Default values should be the most conservative/standard choice
- Questions should be specific to THIS request, not generic
- Return ONLY the JSON array, no explanation`;

	// Use a fast model for quick question generation
	const agentName = "coordination/planner"; // Reuse planner agent config
	
	// Check if the agent exists
	const agentExists = agents.some(a => a.name === agentName);
	if (!agentExists) {
		console.warn(`Warning: Agent "${agentName}" not found. Skipping question generation.`);
		return {
			questions: [],
			cost: 0,
			duration: Date.now() - startTime,
		};
	}
	
	const agentsWithOverride = config.model
		? agents.map((a) => (a.name === agentName ? { ...a, model: config.model } : a))
		: agents;

	const result = await runSingleAgent(
		runtime,
		agentsWithOverride,
		agentName,
		task,
		runtime.cwd,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
	);

	// Check for agent error
	if (result.exitCode !== 0) {
		console.warn(`Warning: Question generation failed with exit code ${result.exitCode}`);
		return {
			questions: [],
			cost: result.usage.cost,
			duration: Date.now() - startTime,
		};
	}

	const output = extractTextFromResult(result);
	const questions = parseQuestionsFromOutput(output, maxQuestions);

	return {
		questions,
		cost: result.usage.cost,
		duration: Date.now() - startTime,
	};
}

// NOTE: Interview tool integration functions removed - subagents run headless
// without UI context, so the interview tool always fails. If direct tool invocation
// is added in the future, these can be re-implemented.

function extractTextFromResult(result: { messages?: Array<{ role: string; content: unknown }> }): string {
	if (!result.messages) return "";

	for (let i = result.messages.length - 1; i >= 0; i--) {
		const msg = result.messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const textBlocks = msg.content.filter(
				(b: unknown) => typeof b === "object" && b !== null && (b as { type: string }).type === "text"
			);
			return textBlocks.map((b: { text?: string }) => b.text || "").join("\n");
		}
	}

	return "";
}

function parseQuestionsFromOutput(output: string, maxQuestions: number): ClarifyingQuestion[] {
	// Try to find JSON array in output
	const jsonMatch = output.match(/\[[\s\S]*\]/);
	if (!jsonMatch) return [];

	try {
		const parsed = JSON.parse(jsonMatch[0]);
		if (!Array.isArray(parsed)) return [];

		const questions: ClarifyingQuestion[] = [];
		
		for (const q of parsed.slice(0, maxQuestions)) {
			if (!q.id || !q.question || !q.type) continue;
			
			const question: ClarifyingQuestion = {
				id: String(q.id),
				question: String(q.question),
				type: validateQuestionType(q.type),
			};

			// Extract context if provided
			if (typeof q.context === "string" && q.context.trim()) {
				question.context = q.context.trim();
			}

			if (question.type === "select" && Array.isArray(q.options)) {
				question.options = q.options
					.filter((o: unknown) => typeof o === "object" && o !== null)
					.map((o: { label?: string; value?: string }) => ({
						label: String(o.label || o.value || ""),
						value: String(o.value || o.label || ""),
					}));
				question.default = typeof q.default === "number" ? q.default : 0;
			} else if (question.type === "text") {
				question.default = typeof q.default === "string" ? q.default : "";
			} else if (question.type === "confirm") {
				question.default = typeof q.default === "boolean" ? q.default : true;
			}

			questions.push(question);
		}

		return questions;
	} catch {
		return [];
	}
}

function validateQuestionType(type: unknown): QuestionType {
	if (type === "select" || type === "text" || type === "confirm") {
		return type;
	}
	return "text"; // Default fallback
}
