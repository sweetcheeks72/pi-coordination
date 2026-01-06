import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ValidationResult, ObservabilityData, InvariantResult } from "./types.js";
import { getEventsByType } from "./loader.js";

export async function generateReport(
	coordDir: string,
	result: ValidationResult,
	data: ObservabilityData,
): Promise<string> {
	const reportPath = path.join(coordDir, "validation-report.md");
	const content = buildReportContent(result, data, coordDir);
	await fs.writeFile(reportPath, content);
	return reportPath;
}

function buildReportContent(
	result: ValidationResult,
	data: ObservabilityData,
	coordDir: string,
): string {
	const lines: string[] = [];

	const sessionCompleted = getEventsByType(data.events, "session_completed")[0];
	const sessionId = sessionCompleted?.traceId || "unknown";

	lines.push("# Validation Report");
	lines.push("");
	lines.push(`**Coordination Session:** ${sessionId}`);
	lines.push(`**Validated:** ${new Date(result.timestamp).toISOString()}`);
	lines.push(`**Duration:** ${(result.duration / 1000).toFixed(2)}s`);
	lines.push(`**Result:** ${result.status.toUpperCase()}`);
	lines.push("");
	lines.push("---");
	lines.push("");

	lines.push("## Summary");
	lines.push("");
	lines.push(result.summary);
	lines.push("");
	lines.push("---");
	lines.push("");

	lines.push("## Invariant Checks");
	lines.push("");
	lines.push("| Invariant | Category | Result | Details |");
	lines.push("|-----------|----------|--------|---------|");

	for (const inv of result.invariants) {
		const status = inv.passed ? "PASS" : "FAIL";
		const details = inv.passed ? "-" : truncate(inv.message, 50);
		lines.push(`| ${inv.name} | ${inv.category} | ${status} | ${details} |`);
	}
	lines.push("");

	const failedInvariants = result.invariants.filter((i) => !i.passed);
	if (failedInvariants.length > 0) {
		lines.push("### Failed Invariants");
		lines.push("");
		for (const inv of failedInvariants) {
			lines.push(`#### ${inv.name} (${inv.category})`);
			lines.push("");
			lines.push(inv.message);
			lines.push("");
			if (inv.details) {
				lines.push("```json");
				lines.push(JSON.stringify(inv.details, null, 2));
				lines.push("```");
				lines.push("");
			}
		}
	}

	lines.push("---");
	lines.push("");

	if (result.judgment) {
		lines.push("## Coordinator Judgment");
		lines.push("");
		lines.push(`**Passed:** ${result.judgment.passed ? "Yes" : "No"}`);
		lines.push(`**Confidence:** ${result.judgment.confidence}`);
		lines.push("");
		lines.push("**Reasoning:**");
		lines.push(result.judgment.reasoning);
		lines.push("");

		if (result.judgment.userQuestionAsked) {
			lines.push("**User Question Asked:**");
			lines.push(`Q: ${result.judgment.userQuestionAsked.question}`);
			lines.push(`A: ${result.judgment.userQuestionAsked.answer || "No response"}`);
			lines.push("");
		}

		lines.push("---");
		lines.push("");
	}

	const suggestedFixes = result.judgment?.suggestedFixes || [];
	if (suggestedFixes.length > 0) {
		lines.push("## Suggested Fixes");
		lines.push("");
		for (let i = 0; i < suggestedFixes.length; i++) {
			lines.push(`${i + 1}. ${suggestedFixes[i]}`);
		}
		lines.push("");
		lines.push("---");
		lines.push("");
	}

	lines.push("## Session Statistics");
	lines.push("");

	if (sessionCompleted?.summary) {
		const s = sessionCompleted.summary;
		lines.push(`- **Status:** ${s.status}`);
		lines.push(`- **Duration:** ${(s.duration / 1000).toFixed(1)}s`);
		lines.push(`- **Total Cost:** $${s.totalCost.toFixed(4)}`);
		lines.push(`- **Workers:** ${s.workersCompleted}/${s.workersSpawned} completed, ${s.workersFailed} failed`);
		lines.push(`- **Files Modified:** ${s.filesModified.length}`);
		lines.push(`- **Review Cycles:** ${s.reviewCycles}`);
	}
	lines.push("");

	lines.push("---");
	lines.push("");

	lines.push("## Raw Data References");
	lines.push("");
	lines.push(`- Events: \`${coordDir}/events.jsonl\``);
	lines.push(`- Spans: \`${coordDir}/traces/spans.jsonl\``);
	lines.push(`- Errors: \`${coordDir}/errors.jsonl\``);
	lines.push(`- Causality: \`${coordDir}/causality.jsonl\``);
	lines.push(`- Resources: \`${coordDir}/resources.jsonl\``);
	lines.push("");

	return lines.join("\n");
}

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 3) + "...";
}
