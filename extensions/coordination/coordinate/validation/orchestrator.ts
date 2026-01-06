import * as fs from "node:fs/promises";
import type {
	ValidationConfig,
	ValidationResult,
	InvariantResult,
	JudgmentResult,
	ObservabilityData,
} from "./types.js";
import { loadObservabilityData, isSessionComplete, getLastEvent } from "./loader.js";
import { runAllInvariants } from "./invariants/index.js";
import { judgeResults } from "./judge.js";
import { generateReport } from "./report.js";
import { validateContent } from "./content.js";

export async function validateCoordination(config: ValidationConfig): Promise<ValidationResult> {
	const startTime = Date.now();

	const data = await loadObservabilityData(config.coordDir);

	if (!isSessionComplete(data)) {
		const lastEvent = getLastEvent(data);
		return {
			status: "incomplete",
			passed: false,
			invariants: [],
			summary: `Session did not complete. Last event: ${lastEvent?.type || "none"} at ${lastEvent?.timestamp || "unknown"}`,
			duration: Date.now() - startTime,
			timestamp: Date.now(),
		};
	}

	const invariantResults = await runAllInvariants(data, config.strictness);

	if (config.checkContent) {
		const contentResult = await validateContent(data);
		if (!contentResult.passed) {
			invariantResults.push({
				name: "Content Validation",
				category: "soft",
				passed: false,
				message: contentResult.issues.join("; "),
				details: contentResult.details,
			});
		} else {
			invariantResults.push({
				name: "Content Validation",
				category: "soft",
				passed: true,
				message: `All ${contentResult.details.filesExpected} expected files exist with content`,
				details: contentResult.details,
			});
		}
	}

	const hardFailures = invariantResults.filter((r) => !r.passed && r.category === "hard");

	let invariantsPassed = true;
	if (config.strictness === "fatal-all") {
		invariantsPassed = invariantResults.every((r) => r.passed);
	} else if (config.strictness === "warn-soft-fatal-hard") {
		invariantsPassed = hardFailures.length === 0;
	}

	let judgment: JudgmentResult | undefined;
	if (config.planContent || config.planPath) {
		const planContent = config.planContent || (await fs.readFile(config.planPath!, "utf-8"));
		judgment = await judgeResults(data, planContent, config.askUser);
	}

	const overallPassed = invariantsPassed && (judgment?.passed ?? true);

	const summary = buildSummary(data, invariantResults, judgment, overallPassed);

	const result: ValidationResult = {
		status: overallPassed ? "pass" : "fail",
		passed: overallPassed,
		invariants: invariantResults,
		judgment,
		summary,
		duration: Date.now() - startTime,
		timestamp: Date.now(),
	};

	const reportPath = await generateReport(config.coordDir, result, data);
	result.reportPath = reportPath;

	return result;
}

function buildSummary(
	data: ObservabilityData,
	invariants: InvariantResult[],
	judgment: JudgmentResult | undefined,
	passed: boolean,
): string {
	const sessionEvent = data.events.find((e) => e.type === "session_completed");
	const summary = sessionEvent?.type === "session_completed" ? sessionEvent.summary : null;

	const parts: string[] = [];

	if (passed) {
		parts.push("Validation PASSED.");
	} else {
		parts.push("Validation FAILED.");
	}

	const passedCount = invariants.filter((i) => i.passed).length;
	const failedCount = invariants.length - passedCount;
	parts.push(`Invariants: ${passedCount}/${invariants.length} passed.`);

	if (failedCount > 0) {
		const failed = invariants.filter((i) => !i.passed).map((i) => i.name);
		parts.push(`Failed: ${failed.join(", ")}.`);
	}

	if (judgment) {
		parts.push(`Coordinator judgment: ${judgment.passed ? "PASS" : "FAIL"} (${judgment.confidence} confidence).`);
	}

	if (summary) {
		parts.push(`Session completed with ${summary.workersCompleted}/${summary.workersSpawned} workers, ${summary.filesModified.length} files modified.`);
	}

	return parts.join(" ");
}

export async function validateCoordinationStreaming(
	config: ValidationConfig,
	onWarning: (invariant: string, message: string) => void,
	onError: (invariant: string, message: string) => void,
): Promise<void> {
	const data = await loadObservabilityData(config.coordDir);

	const results = await runAllInvariants(data, config.strictness);

	for (const result of results) {
		if (!result.passed) {
			if (result.category === "hard") {
				onError(result.name, result.message);
			} else {
				onWarning(result.name, result.message);
			}
		}
	}
}
