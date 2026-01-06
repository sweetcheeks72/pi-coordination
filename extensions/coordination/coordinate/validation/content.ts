import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ObservabilityData, FileOutput } from "./types.js";

export interface ContentValidationResult {
	passed: boolean;
	issues: string[];
	details: {
		filesExpected: number;
		filesExist: number;
		filesMissing: string[];
		filesWithContent: number;
	};
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function validateContent(
	data: ObservabilityData,
	cwd: string = process.cwd(),
): Promise<ContentValidationResult> {
	const issues: string[] = [];
	const filesMissing: string[] = [];

	const expectedFiles = new Set<string>();

	for (const state of data.workerStates) {
		for (const file of state.filesModified) {
			expectedFiles.add(file);
		}
	}

	for (const event of data.events) {
		if (event.type === "worker_completed" && event.result?.filesModified) {
			for (const file of event.result.filesModified) {
				expectedFiles.add(file);
			}
		}
	}

	let filesExist = 0;
	let filesWithContent = 0;

	for (const file of expectedFiles) {
		const fullPath = path.isAbsolute(file) ? file : path.join(cwd, file);
		const exists = await fileExists(fullPath);

		if (!exists) {
			filesMissing.push(file);
			issues.push(`Expected file missing: ${file}`);
		} else {
			filesExist++;

			try {
				const stat = await fs.stat(fullPath);
				if (stat.size > 0) {
					filesWithContent++;
				} else {
					issues.push(`File exists but is empty: ${file}`);
				}
			} catch {
				issues.push(`Could not stat file: ${file}`);
			}
		}
	}

	const passed = issues.length === 0;

	return {
		passed,
		issues,
		details: {
			filesExpected: expectedFiles.size,
			filesExist,
			filesMissing,
			filesWithContent,
		},
	};
}

export async function validateFilePatterns(
	files: FileOutput[],
	patterns: PatternCheck[],
): Promise<{ passed: boolean; issues: string[] }> {
	const issues: string[] = [];

	for (const pattern of patterns) {
		const matchingFiles = files.filter((f) => {
			if (pattern.pathPattern) {
				const regex = new RegExp(pattern.pathPattern);
				if (!regex.test(f.path)) return false;
			}
			return f.exists;
		});

		if (pattern.minCount !== undefined && matchingFiles.length < pattern.minCount) {
			issues.push(
				`Expected at least ${pattern.minCount} files matching ${pattern.pathPattern}, found ${matchingFiles.length}`,
			);
		}

		if (pattern.maxCount !== undefined && matchingFiles.length > pattern.maxCount) {
			issues.push(
				`Expected at most ${pattern.maxCount} files matching ${pattern.pathPattern}, found ${matchingFiles.length}`,
			);
		}
	}

	return {
		passed: issues.length === 0,
		issues,
	};
}

export interface PatternCheck {
	pathPattern?: string;
	minCount?: number;
	maxCount?: number;
}
