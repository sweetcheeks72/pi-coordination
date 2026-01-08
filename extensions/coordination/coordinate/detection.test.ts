/**
 * Tests for input type detection
 * Run with: npx jiti detection.test.ts
 */

import { detectInputType } from "./detection.js";

interface TestCase {
	name: string;
	input: string;
	expected: "spec" | "plan" | "request";
}

const testCases: TestCase[] = [
	// Spec cases
	{
		name: "TASK-XX with files array",
		input: `TASK-01: Add auth
files: [src/auth.ts]
dependsOn: []
acceptanceCriteria: User can log in`,
		expected: "spec",
	},
	{
		name: "JSON task format",
		input: `{"tasks": [{"id": "TASK-01", "files": ["src/auth.ts"]}]}`,
		expected: "spec",
	},
	{
		name: "Markdown TASK format with Files annotation",
		input: `## TASK-01: Create API endpoint
**Files:** \`src/api/routes.ts\` (modify)
**Depends on:** none
**Acceptance:** Endpoint returns 200`,
		expected: "spec",
	},

	// Plan cases
	{
		name: "Phase structure with code blocks",
		input: `## Phase 1
\`\`\`ts
const x = 1;
\`\`\``,
		expected: "plan",
	},
	{
		name: "File path with modify annotation",
		input: `Modify src/api/routes.ts to add endpoint`,
		expected: "plan",
	},
	{
		name: "Line references",
		input: `Update the handler at line 45 in api.ts`,
		expected: "plan",
	},
	{
		name: "Code keywords",
		input: `Add a new function called createUser that exports the User interface`,
		expected: "plan",
	},
	{
		name: "Create/modify annotations",
		input: `Create a new config file (create) and update types (modify)`,
		expected: "plan",
	},

	// Request cases
	{
		name: "Simple prose",
		input: `Add user authentication to the app`,
		expected: "request",
	},
	{
		name: "Prose with requirements",
		input: `Build a dashboard with charts. It should support multiple users and have a clean UI.`,
		expected: "request",
	},
	{
		name: "Feature description",
		input: `I want to add social login support. Users should be able to sign in with Google or GitHub.`,
		expected: "request",
	},
];

let passed = 0;
let failed = 0;

for (const tc of testCases) {
	const result = detectInputType(tc.input);
	if (result.type === tc.expected) {
		console.log(`✓ ${tc.name}`);
		passed++;
	} else {
		console.log(`✗ ${tc.name}`);
		console.log(`  Expected: ${tc.expected}`);
		console.log(`  Got: ${result.type}`);
		console.log(`  Signals: ${result.signals.join(", ")}`);
		failed++;
	}
}

console.log(`\n${passed}/${passed + failed} tests passed`);

if (failed > 0) {
	process.exit(1);
}
