/**
 * Plan Tool - Iterative planning: interview → scout → elaborate → structure → handoff
 *
 * This is the entry point for the plan tool, which creates structured specs
 * from prose, ideas, or existing specs that need refinement.
 *
 * Usage:
 *   plan({ input: "Add authentication" })                    // New plan from prose
 *   plan({ continue: "auth-spec.md" })                      // Refine existing spec
 *   plan({ input: "Add OAuth", output: "specs/oauth.md" })  // Specify output path
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { EventBus, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

import { runInterview, type InterviewResult } from "./interview.js";
import { runTargetedScout, type ScoutResult } from "./scout-targeted.js";
import { elaborate, type ElaborateResult } from "./elaborate.js";
import { structureTasks, type StructureResult } from "./structure.js";
import {
	runHandoff,
	resolveSpecPath,
	type HandoffResult,
	type HandoffChoice,
} from "./handoff.js";
import { parseSpec, type Spec } from "../coordinate/spec-parser.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool Parameters
// ─────────────────────────────────────────────────────────────────────────────

const PlanParams = Type.Object({
	// Input (exactly one required)
	input: Type.Optional(Type.String({ description: "File path or inline text for NEW plans" })),
	continue: Type.Optional(Type.String({ description: "Path to existing spec to REFINE" })),

	// Output
	output: Type.Optional(Type.String({ description: "Where to save spec (default: auto-named in specs/)" })),

	// Models
	model: Type.Optional(Type.String({ description: "Model for elaboration (default: frontier)" })),
	scoutModel: Type.Optional(Type.String({ description: "Model for scout (default: fast)" })),

	// Behavior
	maxInterviewRounds: Type.Optional(Type.Number({ description: "Limit interview rounds (default: 5 new, 3 refine)" })),
	skipInterview: Type.Optional(Type.Boolean({ description: "Skip interview, go straight to scout" })),
	skipScout: Type.Optional(Type.Boolean({ description: "Skip scout phase" })),

	// Output format
	format: Type.Optional(Type.Union([
		Type.Literal("markdown"),
		Type.Literal("json"),
	], { description: "Spec format (default: markdown)" })),
});

type PlanParamsType = Static<typeof PlanParams>;

// ─────────────────────────────────────────────────────────────────────────────
// Tool Details
// ─────────────────────────────────────────────────────────────────────────────

interface PlanDetails {
	specPath: string;
	spec: Spec;
	wasRefined: boolean;
	cost: {
		interview: number;
		scout: number;
		elaborate: number;
		structure: number;
		total: number;
	};
	duration: number;
	choice?: HandoffChoice;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Plan Function
// ─────────────────────────────────────────────────────────────────────────────

interface PlanRuntime {
	cwd: string;
	events: EventBus;
}

interface PlanOptions {
	params: PlanParamsType;
	signal?: AbortSignal;
	onUpdate?: (partial: AgentToolResult<PlanDetails>) => void;
	ctx?: ExtensionContext;
}

async function runPlan(
	runtime: PlanRuntime,
	options: PlanOptions,
): Promise<AgentToolResult<PlanDetails>> {
	const { params, signal, onUpdate, ctx } = options;
	const startTime = Date.now();

	const costs = {
		interview: 0,
		scout: 0,
		elaborate: 0,
		structure: 0,
		total: 0,
	};

	// Validate input parameters
	if (!params.input && !params.continue) {
		return {
			content: [{ type: "text", text: "Error: Either 'input' or 'continue' parameter is required." }],
			isError: true,
		};
	}

	// Determine mode
	const isRefineMode = !!params.continue;
	let input: string;
	let existingSpec: Spec | null = null;

	if (isRefineMode) {
		// Load existing spec
		const specPath = path.isAbsolute(params.continue!)
			? params.continue!
			: path.join(runtime.cwd, params.continue!);

		try {
			const content = await fs.readFile(specPath, "utf-8");
			existingSpec = parseSpec(content, specPath);
			input = content;
		} catch (err) {
			return {
				content: [{ type: "text", text: `Failed to read spec file: ${specPath}\n${err}` }],
				isError: true,
			};
		}
	} else {
		// Check if input is a file path or inline text
		const inputPath = path.isAbsolute(params.input!)
			? params.input!
			: path.join(runtime.cwd, params.input!);

		try {
			// Try to read as file
			input = await fs.readFile(inputPath, "utf-8");
		} catch {
			// Not a file - treat as inline text
			input = params.input!;
		}
	}

	// ───────────────────────────────────────────────────────────────────────
	// Phase 1: Interview
	// ───────────────────────────────────────────────────────────────────────

	let interviewResult: InterviewResult;

	if (params.skipInterview) {
		interviewResult = {
			collectedInfo: { originalInput: input },
			transcript: "(Interview skipped)",
			totalRounds: 0,
			wasAborted: false,
			cost: 0,
			duration: 0,
			rounds: [],
		};
	} else {
		onUpdate?.({
			content: [{ type: "text", text: "Gathering requirements..." }],
		});

		interviewResult = await runInterview(runtime, input, {
			maxRounds: params.maxInterviewRounds ?? (isRefineMode ? 3 : 5),
			model: params.model,
			signal,
			mode: isRefineMode ? "refine" : "new",
		}, ctx);

		costs.interview = interviewResult.cost;
		costs.total += interviewResult.cost;

		if (interviewResult.wasAborted) {
			return {
				content: [{ type: "text", text: "Planning aborted by user." }],
				isError: false,
			};
		}
	}

	// ───────────────────────────────────────────────────────────────────────
	// Phase 2: Scout
	// ───────────────────────────────────────────────────────────────────────

	let scoutResult: ScoutResult;

	// Skip scout if explicitly requested, or if refining and no new areas discovered
	const shouldSkipScout = params.skipScout ||
		(isRefineMode && !interviewResult.needsNewScout);

	if (shouldSkipScout) {
		scoutResult = {
			contextDoc: existingSpec?.context || "(Scout skipped)",
			metaPrompt: "(Scout skipped - using existing context)",
			keyFiles: [],
			tokenMetrics: { contextTokens: 0, metaTokens: 0, totalTokens: 0, budget: 100000 },
			duration: 0,
			cost: 0,
		};
	} else {
		onUpdate?.({
			content: [{ type: "text", text: "Analyzing codebase..." }],
		});

		scoutResult = await runTargetedScout(runtime, input, interviewResult, {
			model: params.scoutModel,
			cwd: runtime.cwd,
			signal,
		});

		costs.scout = scoutResult.cost;
		costs.total += scoutResult.cost;
	}

	// ───────────────────────────────────────────────────────────────────────
	// Phase 3: Elaborate
	// ───────────────────────────────────────────────────────────────────────

	onUpdate?.({
		content: [{ type: "text", text: "Creating detailed plan..." }],
	});

	const elaborateResult = await elaborate(runtime, input, interviewResult, scoutResult, {
		model: params.model,
		mode: isRefineMode ? "refine" : "new",
		signal,
	});

	costs.elaborate = elaborateResult.cost;
	costs.total += elaborateResult.cost;

	// ───────────────────────────────────────────────────────────────────────
	// Phase 4: Structure
	// ───────────────────────────────────────────────────────────────────────

	onUpdate?.({
		content: [{ type: "text", text: "Structuring tasks..." }],
	});

	const structureResult = await structureTasks(
		runtime,
		elaborateResult.plan,
		input,
		{
			model: params.model,
			signal,
		},
	);

	costs.structure = structureResult.cost;
	costs.total += structureResult.cost;

	// Resolve output path
	const specPath = resolveSpecPath(
		runtime.cwd,
		params.output || (isRefineMode ? params.continue : undefined),
		structureResult.spec.title || "spec",
	);

	// ───────────────────────────────────────────────────────────────────────
	// Phase 5: Handoff
	// ───────────────────────────────────────────────────────────────────────

	const handoffResult = await runHandoff(structureResult.spec, specPath, {
		signal,
		autoSave: true,
	}, ctx);

	const details: PlanDetails = {
		specPath,
		spec: structureResult.spec,
		wasRefined: isRefineMode,
		cost: costs,
		duration: Date.now() - startTime,
		choice: handoffResult.choice,
	};

	// Handle user choice
	if (handoffResult.choice === "execute") {
		// Return with instruction to call coordinate
		return {
			content: [{
				type: "text",
				text: `Spec saved to: ${specPath}\n\n` +
					`To execute, run:\n` +
					`  coordinate({ plan: "${specPath}" })\n\n` +
					`Cost: $${costs.total.toFixed(4)} | Duration: ${formatDuration(details.duration)}`,
			}],
			details,
		};
	} else if (handoffResult.choice === "refine") {
		// Return with instruction to call plan with continue
		return {
			content: [{
				type: "text",
				text: `Spec saved to: ${specPath}\n\n` +
					`To refine, run:\n` +
					`  plan({ continue: "${specPath}" })\n\n` +
					`Cost: $${costs.total.toFixed(4)} | Duration: ${formatDuration(details.duration)}`,
			}],
			details,
		};
	} else {
		// Exit - just save
		return {
			content: [{
				type: "text",
				text: `Spec saved to: ${specPath}\n\n` +
					`Tasks: ${structureResult.spec.tasks.length}\n` +
					`Cost: $${costs.total.toFixed(4)} | Duration: ${formatDuration(details.duration)}\n\n` +
					(structureResult.warnings.length > 0
						? `Warnings:\n${structureResult.warnings.map((w) => `  - ${w}`).join("\n")}`
						: ""),
			}],
			details,
		};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definition
// ─────────────────────────────────────────────────────────────────────────────

export function createPlanTool(events: EventBus): ToolDefinition<typeof PlanParams, PlanDetails> {
	return {
		name: "plan",
		label: "Plan",
		description:
			"Create a structured spec from prose, idea, or PRD. Conducts an interview, analyzes the codebase, and produces a TASK-XX format spec ready for coordinate tool.",
		parameters: PlanParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await runPlan(
				{ cwd: ctx.cwd, events },
				{
					params: params as PlanParamsType,
					signal,
					onUpdate,
					ctx,
				},
			);
			return result;
		},

		renderCall(args, theme) {
			const input = args.input || args.continue || "...";
			const mode = args.continue ? "refine" : "new";
			const modeIcon = mode === "refine" ? "✏️" : "📝";
			const text = theme.fg("toolTitle", theme.bold("plan ")) +
				theme.fg("accent", `${modeIcon} ${truncate(input, 50)}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const { details } = result;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const lines: string[] = [];

			// Header
			const icon = details.choice === "execute" ? "🚀" : details.choice === "refine" ? "✏️" : "💾";
			lines.push(`${icon} ${details.spec.title || "Plan Complete"}`);
			lines.push("");

			// Stats
			lines.push(`📁 ${details.specPath}`);
			lines.push(`📊 Tasks: ${details.spec.tasks.length} | Cost: $${details.cost.total.toFixed(4)}`);

			if (expanded) {
				lines.push("");
				lines.push("Tasks:");
				for (const task of details.spec.tasks.slice(0, 5)) {
					lines.push(`  ${task.id}: ${task.title}`);
				}
				if (details.spec.tasks.length > 5) {
					lines.push(`  ... and ${details.spec.tasks.length - 5} more`);
				}
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 3) + "...";
}

// Export for use in extension registration
export { runPlan, type PlanDetails, type PlanParamsType };
