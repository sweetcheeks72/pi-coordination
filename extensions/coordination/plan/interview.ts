/**
 * Interview Module - Multi-round interview to gather requirements.
 *
 * This module conducts a structured interview with the user to clarify
 * requirements before planning. It reuses the existing inline-questions-tui.ts
 * for rendering and question-generator.ts for LLM-based question generation.
 *
 * Flow:
 * 1. Discovery round (open questions about the request)
 * 2. Technical decisions (structured select options)
 * 3. Scope & constraints (mixed format)
 * 4. Optional follow-up rounds based on LLM analysis
 *
 * Each question has a 60-second timeout. Timeout = use default and continue.
 * ESC on first question = abort planning entirely.
 *
 * @module
 */

import type { AgentRuntime } from "../subagent/runner.js";
import { discoverAgents } from "../subagent/agents.js";
import { runSingleAgent } from "../subagent/runner.js";
import {
	runInlineQuestionsTUI,
	type Answer,
	type InlineQuestionsTUIResult,
} from "../coordinate/inline-questions-tui.js";
import type {
	ClarifyingQuestion,
	QuestionType,
	QuestionOption,
} from "../coordinate/question-generator.js";

/**
 * Interview round type.
 */
export type InterviewRoundType = "discovery" | "technical" | "scope" | "clarification";

/**
 * A single interview round.
 */
export interface InterviewRound {
	type: InterviewRoundType;
	questions: ClarifyingQuestion[];
	answers: Answer[];
}

/**
 * Interview configuration.
 */
export interface InterviewConfig {
	/** Maximum interview rounds (default: 5 for new, 3 for refine) */
	maxRounds?: number;
	/** Model for question generation */
	model?: string;
	/** Abort signal */
	signal?: AbortSignal;
	/** Mode: "new" for new plans, "refine" for existing specs */
	mode?: "new" | "refine";
	/** Timeout per question in seconds (default: 60) */
	timeout?: number;
}

/**
 * Result from running an interview.
 */
export interface InterviewResult {
	/** Collected information from answers */
	collectedInfo: Record<string, unknown>;
	/** Formatted transcript of the interview */
	transcript: string;
	/** Number of rounds completed */
	totalRounds: number;
	/** Whether interview was aborted */
	wasAborted: boolean;
	/** Total LLM cost for question generation */
	cost: number;
	/** Total duration in ms */
	duration: number;
	/** Whether new scout is needed (for refine mode) */
	needsNewScout?: boolean;
	/** All interview rounds */
	rounds: InterviewRound[];
}

/**
 * Generate discovery questions for the first round.
 */
async function generateDiscoveryQuestions(
	runtime: AgentRuntime,
	input: string,
	model: string | undefined,
	mode: "new" | "refine",
): Promise<{ questions: ClarifyingQuestion[]; cost: number }> {
	const { agents } = discoverAgents(runtime.cwd, "user");

	const modeContext = mode === "refine"
		? `This is a REFINEMENT of an existing spec. Ask about what changes the user wants to make:
- What specific aspects need adjustment?
- Are there new requirements to add?
- What worked well that should be kept?
- Are there new files/modules to consider?`
		: `This is a NEW plan. Ask foundational questions:
- What is the core goal?
- What does success look like?
- Are there constraints or preferences?`;

	const task = `Generate 3-5 discovery questions for this request.

<request>
${input}
</request>

<context>
${modeContext}
</context>

Output a JSON array of questions. Each question should probe a real design decision.

Format:
\`\`\`json
[
  {
    "id": "unique_id",
    "question": "Open-ended question?",
    "type": "text",
    "context": "Why this matters"
  },
  {
    "id": "choice_id",
    "question": "Multiple choice question?",
    "type": "select",
    "options": [
      {"label": "Option A", "value": "a"},
      {"label": "Option B", "value": "b"},
      {"label": "Other (specify)", "value": "other"}
    ],
    "default": 0,
    "context": "Tradeoff explanation"
  }
]
\`\`\`

Rules:
- Mix question types (text for open-ended, select for choices, confirm for yes/no)
- Include context explaining why each question matters
- For select: always include an "Other" option
- Focus on non-obvious design decisions
- Return ONLY the JSON array`;

	const agentName = "coordination/planner";
	const agentExists = agents.some((a) => a.name === agentName);

	if (!agentExists) {
		// Return default discovery questions if agent not found
		return {
			questions: [
				{
					id: "goal",
					question: "What is the core goal of this change?",
					type: "text" as QuestionType,
					context: "Understanding the main objective helps prioritize tasks",
				},
				{
					id: "success",
					question: "What does success look like?",
					type: "text" as QuestionType,
					context: "Defines the acceptance criteria",
				},
			],
			cost: 0,
		};
	}

	const agentsWithModel = model
		? agents.map((a) => (a.name === agentName ? { ...a, model } : a))
		: agents;

	const result = await runSingleAgent(
		runtime,
		agentsWithModel,
		agentName,
		task,
		runtime.cwd,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
	);

	if (result.exitCode !== 0) {
		return { questions: [], cost: result.usage.cost };
	}

	const output = extractTextFromResult(result);
	const questions = parseQuestionsFromOutput(output);

	return { questions, cost: result.usage.cost };
}

/**
 * Analyze interview state and determine next questions.
 */
async function analyzeInterviewState(
	runtime: AgentRuntime,
	rounds: InterviewRound[],
	originalInput: string,
	model: string | undefined,
	mode: "new" | "refine",
): Promise<{
	isComplete: boolean;
	nextQuestions: ClarifyingQuestion[];
	roundType: InterviewRoundType;
	needsNewScout: boolean;
	cost: number;
}> {
	const { agents } = discoverAgents(runtime.cwd, "user");

	const transcript = formatRoundsAsTranscript(rounds);

	const task = `Analyze this interview and decide if more questions are needed.

<original_request>
${originalInput}
</original_request>

<interview_transcript>
${transcript}
</interview_transcript>

<mode>
${mode === "refine" ? "Refinement of existing spec" : "New plan creation"}
</mode>

Determine:
1. Is there enough information to proceed? (isComplete: true/false)
2. If not complete, what type of questions are needed next?
3. Are there NEW areas of the codebase mentioned that weren't in the original? (needsNewScout: true/false)

Output JSON:
\`\`\`json
{
  "isComplete": false,
  "roundType": "technical|scope|clarification",
  "needsNewScout": false,
  "reasoning": "Why more questions are needed or why we have enough",
  "nextQuestions": [
    {
      "id": "...",
      "question": "...",
      "type": "text|select|confirm",
      "options": [...],
      "context": "..."
    }
  ]
}
\`\`\`

If isComplete is true, nextQuestions should be empty.
Return ONLY the JSON.`;

	const agentName = "coordination/planner";
	const agentExists = agents.some((a) => a.name === agentName);

	if (!agentExists) {
		return {
			isComplete: true,
			nextQuestions: [],
			roundType: "clarification",
			needsNewScout: false,
			cost: 0,
		};
	}

	const agentsWithModel = model
		? agents.map((a) => (a.name === agentName ? { ...a, model } : a))
		: agents;

	const result = await runSingleAgent(
		runtime,
		agentsWithModel,
		agentName,
		task,
		runtime.cwd,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", results, agentScope: "user", projectAgentsDir: null }),
	);

	if (result.exitCode !== 0) {
		return {
			isComplete: true,
			nextQuestions: [],
			roundType: "clarification",
			needsNewScout: false,
			cost: result.usage.cost,
		};
	}

	const output = extractTextFromResult(result);
	const analysis = parseAnalysisFromOutput(output);

	return {
		isComplete: analysis.isComplete,
		nextQuestions: analysis.nextQuestions,
		roundType: analysis.roundType || "clarification",
		needsNewScout: analysis.needsNewScout || false,
		cost: result.usage.cost,
	};
}

/**
 * Run a multi-round interview to gather requirements.
 */
export async function runInterview(
	runtime: AgentRuntime,
	input: string,
	config: InterviewConfig = {},
): Promise<InterviewResult> {
	const startTime = Date.now();
	const {
		maxRounds = config.mode === "refine" ? 3 : 5,
		model,
		signal,
		mode = "new",
		timeout = 60,
	} = config;

	let totalCost = 0;
	const rounds: InterviewRound[] = [];

	// Non-TTY fallback: skip interview, use input as-is
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return {
			collectedInfo: { originalInput: input },
			transcript: `Original request:\n${input}\n\n(Interview skipped - non-TTY environment)`,
			totalRounds: 0,
			wasAborted: false,
			cost: 0,
			duration: Date.now() - startTime,
			rounds: [],
		};
	}

	// Check if already aborted
	if (signal?.aborted) {
		return {
			collectedInfo: { originalInput: input },
			transcript: "(Interview aborted)",
			totalRounds: 0,
			wasAborted: true,
			cost: 0,
			duration: Date.now() - startTime,
			rounds: [],
		};
	}

	// Round 1: Discovery questions (always runs)
	const { questions: discoveryQuestions, cost: discoveryCost } =
		await generateDiscoveryQuestions(runtime, input, model, mode);
	totalCost += discoveryCost;

	if (discoveryQuestions.length === 0) {
		// No questions generated - proceed with input as-is
		return {
			collectedInfo: { originalInput: input },
			transcript: `Original request:\n${input}\n\n(No clarifying questions needed)`,
			totalRounds: 0,
			wasAborted: false,
			cost: totalCost,
			duration: Date.now() - startTime,
			rounds: [],
		};
	}

	const discoveryResult = await runInlineQuestionsTUI({
		questions: discoveryQuestions,
		timeout,
		signal,
	});

	if (discoveryResult.skippedAll) {
		return {
			collectedInfo: { originalInput: input },
			transcript: formatTranscript(rounds),
			totalRounds: 0,
			wasAborted: true,
			cost: totalCost,
			duration: Date.now() - startTime,
			rounds: [],
		};
	}

	rounds.push({
		type: "discovery",
		questions: discoveryQuestions,
		answers: discoveryResult.answers,
	});

	// Subsequent rounds: LLM decides what's needed
	let needsNewScout = false;
	for (let round = 1; round < maxRounds; round++) {
		const analysis = await analyzeInterviewState(
			runtime,
			rounds,
			input,
			model,
			mode,
		);
		totalCost += analysis.cost;

		if (analysis.needsNewScout) {
			needsNewScout = true;
		}

		if (analysis.isComplete || analysis.nextQuestions.length === 0) {
			break;
		}

		const result = await runInlineQuestionsTUI({
			questions: analysis.nextQuestions,
			timeout,
			signal,
		});

		if (result.skippedAll) {
			break; // User wants to proceed with what we have
		}

		rounds.push({
			type: analysis.roundType,
			questions: analysis.nextQuestions,
			answers: result.answers,
		});
	}

	const collectedInfo = extractCollectedInfo(rounds);
	collectedInfo.needsNewScout = needsNewScout;

	return {
		collectedInfo,
		transcript: formatTranscript(rounds),
		totalRounds: rounds.length,
		wasAborted: false,
		cost: totalCost,
		duration: Date.now() - startTime,
		needsNewScout,
		rounds,
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

function parseQuestionsFromOutput(output: string): ClarifyingQuestion[] {
	const jsonMatch = output.match(/\[[\s\S]*\]/);
	if (!jsonMatch) return [];

	try {
		const parsed = JSON.parse(jsonMatch[0]);
		if (!Array.isArray(parsed)) return [];

		const questions: ClarifyingQuestion[] = [];

		for (const q of parsed) {
			if (!q.id || !q.question || !q.type) continue;

			const question: ClarifyingQuestion = {
				id: String(q.id),
				question: String(q.question),
				type: validateQuestionType(q.type),
			};

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

function parseAnalysisFromOutput(output: string): {
	isComplete: boolean;
	nextQuestions: ClarifyingQuestion[];
	roundType?: InterviewRoundType;
	needsNewScout?: boolean;
} {
	const jsonMatch = output.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return { isComplete: true, nextQuestions: [] };

	try {
		const parsed = JSON.parse(jsonMatch[0]);
		return {
			isComplete: parsed.isComplete === true,
			nextQuestions: Array.isArray(parsed.nextQuestions)
				? parseQuestionsFromOutput(JSON.stringify(parsed.nextQuestions))
				: [],
			roundType: validateRoundType(parsed.roundType),
			needsNewScout: parsed.needsNewScout === true,
		};
	} catch {
		return { isComplete: true, nextQuestions: [] };
	}
}

function validateQuestionType(type: unknown): QuestionType {
	if (type === "select" || type === "text" || type === "confirm") {
		return type;
	}
	return "text";
}

function validateRoundType(type: unknown): InterviewRoundType {
	if (
		type === "discovery" ||
		type === "technical" ||
		type === "scope" ||
		type === "clarification"
	) {
		return type;
	}
	return "clarification";
}

function extractCollectedInfo(rounds: InterviewRound[]): Record<string, unknown> {
	const info: Record<string, unknown> = {};

	for (const round of rounds) {
		for (const answer of round.answers) {
			info[answer.questionId] = answer.value;
			if (answer.selectedOption) {
				info[`${answer.questionId}_option`] = answer.selectedOption;
			}
		}
	}

	return info;
}

function formatRoundsAsTranscript(rounds: InterviewRound[]): string {
	const lines: string[] = [];

	for (const round of rounds) {
		lines.push(`### Round: ${round.type}`);
		for (let i = 0; i < round.questions.length; i++) {
			const q = round.questions[i];
			const a = round.answers[i];
			lines.push(`Q: ${q.question}`);
			if (a) {
				const valueStr =
					a.type === "confirm"
						? a.value
							? "Yes"
							: "No"
						: a.selectedOption
							? a.selectedOption.label
							: String(a.value);
				lines.push(`A: ${valueStr}${a.wasTimeout ? " (timeout)" : ""}`);
			}
			lines.push("");
		}
	}

	return lines.join("\n").trim();
}

function formatTranscript(rounds: InterviewRound[]): string {
	if (rounds.length === 0) {
		return "(No interview conducted)";
	}

	const lines: string[] = ["# Interview Transcript", ""];

	for (let i = 0; i < rounds.length; i++) {
		const round = rounds[i];
		lines.push(`## Round ${i + 1}: ${capitalizeFirst(round.type)}`);
		lines.push("");

		for (let j = 0; j < round.questions.length; j++) {
			const q = round.questions[j];
			const a = round.answers[j];

			lines.push(`**Q${j + 1}:** ${q.question}`);
			if (q.context) {
				lines.push(`*Context: ${q.context}*`);
			}

			if (a) {
				const valueStr =
					a.type === "confirm"
						? a.value
							? "Yes"
							: "No"
						: a.selectedOption
							? a.selectedOption.label
							: String(a.value);
				const suffix = a.wasTimeout ? " *(timeout - used default)*" : "";
				lines.push(`**A:** ${valueStr}${suffix}`);
			} else {
				lines.push(`**A:** *(skipped)*`);
			}
			lines.push("");
		}
	}

	return lines.join("\n").trim();
}

function capitalizeFirst(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
