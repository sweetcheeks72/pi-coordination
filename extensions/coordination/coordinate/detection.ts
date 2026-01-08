/**
 * Input type detection for smart routing
 * Determines if input is a spec (ready to execute), plan (needs task extraction), or request (needs scoping)
 */

export type InputType = "spec" | "plan" | "request";

export interface DetectionResult {
	type: InputType;
	confidence: "high" | "medium" | "low";
	signals: string[];
}

/**
 * Detect input type based on content heuristics
 * @param content - The markdown/text content to analyze
 * @returns Detection result with type, confidence, and signals found
 */
export function detectInputType(content: string): DetectionResult {
	// ─────────────────────────────────────────────────────────────────
	// SPEC: Has explicit task structure ready to execute
	// ─────────────────────────────────────────────────────────────────
	const hasTaskIds = /TASK-\d+/i.test(content);
	const hasJsonTasks = /"tasks"\s*:\s*\[/.test(content);
	const hasFilesArray = /files:\s*\[/.test(content);
	const hasJsonFiles = /"files"\s*:\s*\[/.test(content); // JSON format: "files": [...]
	const hasDepsArray = /dependsOn:\s*\[/.test(content);
	const hasJsonDeps = /"dependsOn"\s*:\s*\[/.test(content); // JSON format
	const hasDependsOnArray = /depends\s*on:\s*\[/i.test(content);
	const hasCriteria = /acceptanceCriteria:/i.test(content);
	const hasJsonCriteria = /"acceptanceCriteria"\s*:\s*\[/.test(content); // JSON format
	const hasAcceptance = /\*\*Acceptance:?\*\*/i.test(content);

	// Need task IDs AND at least one structural element
	const hasTaskStructure = hasTaskIds || hasJsonTasks;
	const hasStructuralElement = hasFilesArray || hasJsonFiles || hasDepsArray || hasDependsOnArray || hasJsonDeps || hasCriteria || hasAcceptance || hasJsonCriteria;

	if (hasTaskStructure && hasStructuralElement) {
		const specSignals: string[] = [];
		if (hasTaskIds) specSignals.push("TASK-XX identifiers");
		if (hasJsonTasks) specSignals.push("JSON tasks array");
		if (hasFilesArray || hasJsonFiles) specSignals.push("files: [] syntax");
		if (hasDepsArray || hasDependsOnArray || hasJsonDeps) specSignals.push("dependsOn: [] syntax");
		if (hasCriteria || hasAcceptance || hasJsonCriteria) specSignals.push("acceptance criteria");
		
		return {
			type: "spec",
			confidence: specSignals.length >= 3 ? "high" : "medium",
			signals: specSignals,
		};
	}

	// ─────────────────────────────────────────────────────────────────
	// PLAN: Has implementation detail but not task format
	// ─────────────────────────────────────────────────────────────────
	const hasCodeBlocks = /```[\w]*\n[\s\S]+?\n```/.test(content);
	const hasFilePaths = /\b[\w\-\/]+\.(ts|js|tsx|jsx|py|go|rs|java|rb|php|vue|svelte|css|scss|html|json|yaml|yml|md|sql)\b/.test(content);
	const hasLineRefs = /line\s+\d+|:\d+[-–]\d+|L\d+/i.test(content);
	const hasPhases = /^#{1,3}\s*(Phase|Stage|Step|Part)\s+\d+/mi.test(content);
	const hasCreateModify = /\((create|modify|update|add|delete|new|change)\)/i.test(content);
	const hasCodeTerms = /\b(function|class|interface|import|export|const|let|var|def|fn|pub|struct|enum)\b/.test(content);
	const hasFileAction = /\*\*Files?:?\*\*/i.test(content);

	const planSignals: string[] = [];
	if (hasCodeBlocks) planSignals.push("code blocks");
	if (hasFilePaths) planSignals.push("file paths");
	if (hasLineRefs) planSignals.push("line references");
	if (hasPhases) planSignals.push("phase/step structure");
	if (hasCreateModify) planSignals.push("create/modify annotations");
	if (hasCodeTerms) planSignals.push("code keywords");
	if (hasFileAction) planSignals.push("**Files:** annotations");

	if (planSignals.length >= 1) {
		return {
			type: "plan",
			confidence: planSignals.length >= 3 ? "high" : planSignals.length >= 2 ? "medium" : "low",
			signals: planSignals,
		};
	}

	// ─────────────────────────────────────────────────────────────────
	// REQUEST: Prose, no structural signals
	// ─────────────────────────────────────────────────────────────────
	return {
		type: "request",
		confidence: "high",
		signals: ["prose only"],
	};
}

/**
 * Get human-readable description for each input type
 */
export function getInputTypeDescription(type: InputType): { label: string; description: string } {
	switch (type) {
		case "spec":
			return {
				label: "Spec",
				description: "ready to execute (has TASK-XX, files, deps)",
			};
		case "plan":
			return {
				label: "Plan",
				description: "needs task extraction (detailed but unformatted)",
			};
		case "request":
			return {
				label: "Request",
				description: "needs scoping (feature idea, PRD, prose)",
			};
	}
}
