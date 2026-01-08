/**
 * Tests for PRD augmentation
 * Run with: npx jiti augment-prd.test.ts
 */

import { augmentPRD, extractClarifications } from "./augment-prd.js";
import type { Answer } from "./inline-questions-tui.js";

const originalPRD = `# Feature Request

Add user authentication to the app.`;

const answers: Answer[] = [
	{
		questionId: "scope",
		question: "What's the scope?",
		type: "select",
		value: "mvp",
		selectedOption: { label: "MVP - just email/password", value: "mvp" },
		wasTimeout: false,
		wasCustom: false,
	},
	{
		questionId: "social",
		question: "Include social login?",
		type: "select",
		value: "google",
		selectedOption: { label: "Google only", value: "google" },
		wasTimeout: true,
		wasCustom: false,
	},
	{
		questionId: "tests",
		question: "Add tests?",
		type: "confirm",
		value: true,
		wasTimeout: false,
		wasCustom: false,
	},
	{
		questionId: "focus",
		question: "Focus areas?",
		type: "text",
		value: "src/auth/, src/api/",
		wasTimeout: false,
		wasCustom: true,
	},
];

console.log("Testing augmentPRD...");

const augmented = augmentPRD(originalPRD, answers);

// Check structure
if (!augmented.includes("## Clarifications")) {
	console.log("✗ Missing Clarifications section");
	process.exit(1);
}

if (!augmented.includes("---")) {
	console.log("✗ Missing separator");
	process.exit(1);
}

// Check answers are formatted correctly
if (!augmented.includes("**What's the scope?**: MVP - just email/password")) {
	console.log("✗ Scope answer not formatted correctly");
	process.exit(1);
}

if (!augmented.includes("*(default - no response)*")) {
	console.log("✗ Timeout marker missing");
	process.exit(1);
}

if (!augmented.includes("**Add tests?**: Yes")) {
	console.log("✗ Confirm answer not formatted correctly");
	process.exit(1);
}

if (!augmented.includes("*(custom)*")) {
	console.log("✗ Custom marker missing");
	process.exit(1);
}

console.log("✓ augmentPRD produces correct output");

// Test extractClarifications
console.log("\nTesting extractClarifications...");

const extracted = extractClarifications(augmented);
if (!extracted) {
	console.log("✗ Failed to extract clarifications");
	process.exit(1);
}

if (!extracted.includes("What's the scope?")) {
	console.log("✗ Extracted clarifications missing content");
	process.exit(1);
}

console.log("✓ extractClarifications works correctly");

// Test empty answers
console.log("\nTesting empty answers...");

const unchanged = augmentPRD(originalPRD, []);
if (unchanged !== originalPRD) {
	console.log("✗ Empty answers should not modify PRD");
	process.exit(1);
}

console.log("✓ Empty answers handled correctly");

console.log("\nAll tests passed!");
