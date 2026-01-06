import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateCoordination } from "../coordinate/validation/index.js";
import type { ValidationConfig, ValidationResult } from "../coordinate/validation/types.js";

interface ValidateCoordArgs {
	coordDir: string;
	plan?: string;
	strictness?: "fatal-all" | "warn-soft-fatal-hard" | "advisory";
	checkContent?: boolean;
	json?: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function validateCoord(args: ValidateCoordArgs): Promise<ValidationResult> {
	const coordDir = path.resolve(args.coordDir);

	if (!(await fileExists(coordDir))) {
		throw new Error(`Coordination directory not found: ${coordDir}`);
	}

	const eventsPath = path.join(coordDir, "events.jsonl");
	if (!(await fileExists(eventsPath))) {
		throw new Error(`No events.jsonl found in ${coordDir}. Is this a valid coordination directory?`);
	}

	let planContent: string | undefined;
	let planPath: string | undefined;

	if (args.plan) {
		planPath = path.resolve(args.plan);
		if (!(await fileExists(planPath))) {
			throw new Error(`Plan file not found: ${planPath}`);
		}
		planContent = await fs.readFile(planPath, "utf-8");
	}

	const config: ValidationConfig = {
		coordDir,
		planPath,
		planContent,
		mode: "post-hoc",
		strictness: args.strictness || "warn-soft-fatal-hard",
		checkContent: args.checkContent ?? true,
	};

	const result = await validateCoordination(config);

	if (args.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		printResult(result);
	}

	return result;
}

function printResult(result: ValidationResult): void {
	const statusEmoji = result.passed ? "[PASS]" : "[FAIL]";
	console.log(`\n${statusEmoji} Validation ${result.status.toUpperCase()}\n`);
	console.log(result.summary);
	console.log("");

	console.log("Invariants:");
	for (const inv of result.invariants) {
		const status = inv.passed ? "[OK]" : "[FAIL]";
		console.log(`  ${status} ${inv.name} (${inv.category})`);
		if (!inv.passed) {
			console.log(`       ${inv.message}`);
		}
	}
	console.log("");

	if (result.judgment) {
		console.log(`Coordinator Judgment: ${result.judgment.passed ? "PASS" : "FAIL"} (${result.judgment.confidence})`);
		console.log(`  ${result.judgment.reasoning}`);
		console.log("");
	}

	if (result.reportPath) {
		console.log(`Full report: ${result.reportPath}`);
	}

	console.log(`Duration: ${(result.duration / 1000).toFixed(2)}s`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		console.log(`
Usage: validate-coord <coordDir> [options]

Arguments:
  coordDir              Path to coordination directory

Options:
  --plan <path>         Path to plan file for semantic validation
  --strictness <level>  fatal-all | warn-soft-fatal-hard | advisory (default: warn-soft-fatal-hard)
  --check-content       Validate file outputs (default: true)
  --no-check-content    Skip file output validation
  --json                Output as JSON
  --help, -h            Show this help

Examples:
  validate-coord ~/.pi/sessions/default/coordination/abc123
  validate-coord ./my-coord-dir --plan ./plan.md
  validate-coord ./my-coord-dir --json
`);
		process.exit(0);
	}

	const coordDir = args[0];
	const options: ValidateCoordArgs = { coordDir };

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--plan":
				options.plan = args[++i];
				break;
			case "--strictness":
				options.strictness = args[++i] as ValidateCoordArgs["strictness"];
				break;
			case "--check-content":
				options.checkContent = true;
				break;
			case "--no-check-content":
				options.checkContent = false;
				break;
			case "--json":
				options.json = true;
				break;
		}
	}

	try {
		const result = await validateCoord(options);
		process.exit(result.passed ? 0 : 1);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : error}`);
		process.exit(2);
	}
}

main();
