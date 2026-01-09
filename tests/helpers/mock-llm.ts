/**
 * Mock LLM for testing without making real API calls.
 *
 * Provides deterministic responses for testing plan/coordinate flows.
 *
 * @module
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MockLLMConfig {
	/** Default response for prompts without specific handlers */
	defaultResponse?: string;
	/** Map of prompt patterns to responses */
	responses?: Map<RegExp | string, string | MockLLMHandler>;
	/** Simulated cost per call */
	costPerCall?: number;
	/** Simulated input tokens */
	inputTokensPerCall?: number;
	/** Simulated output tokens */
	outputTokensPerCall?: number;
	/** Should calls fail? */
	shouldFail?: boolean;
	/** Error message if shouldFail is true */
	errorMessage?: string;
	/** Delay before responding (ms) */
	responseDelayMs?: number;
}

export type MockLLMHandler = (prompt: string) => string | Promise<string>;

export interface MockLLMResponse {
	text: string;
	cost: number;
	inputTokens: number;
	outputTokens: number;
}

export interface MockLLMCall {
	prompt: string;
	response: string;
	timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock LLM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MockLLM provides deterministic responses for testing.
 */
export class MockLLM {
	private config: MockLLMConfig;
	private calls: MockLLMCall[] = [];

	constructor(config: MockLLMConfig = {}) {
		this.config = {
			defaultResponse: "Mock LLM response",
			costPerCall: 0.01,
			inputTokensPerCall: 100,
			outputTokensPerCall: 50,
			...config,
		};
	}

	/**
	 * Generate a response for a prompt.
	 */
	async generate(prompt: string): Promise<MockLLMResponse> {
		// Check for failure
		if (this.config.shouldFail) {
			throw new Error(this.config.errorMessage || "Mock LLM failure");
		}

		// Simulate delay
		if (this.config.responseDelayMs) {
			await this.delay(this.config.responseDelayMs);
		}

		// Find matching response
		let text = this.config.defaultResponse || "";

		if (this.config.responses) {
			for (const [pattern, responseOrHandler] of this.config.responses) {
				const matches = typeof pattern === "string"
					? prompt.includes(pattern)
					: pattern.test(prompt);

				if (matches) {
					if (typeof responseOrHandler === "function") {
						text = await responseOrHandler(prompt);
					} else {
						text = responseOrHandler;
					}
					break;
				}
			}
		}

		// Record call
		this.calls.push({
			prompt,
			response: text,
			timestamp: Date.now(),
		});

		return {
			text,
			cost: this.config.costPerCall || 0.01,
			inputTokens: this.config.inputTokensPerCall || 100,
			outputTokens: this.config.outputTokensPerCall || 50,
		};
	}

	/**
	 * Get all calls made to this mock.
	 */
	getCalls(): MockLLMCall[] {
		return [...this.calls];
	}

	/**
	 * Get the number of calls made.
	 */
	getCallCount(): number {
		return this.calls.length;
	}

	/**
	 * Reset call history.
	 */
	reset(): void {
		this.calls = [];
	}

	/**
	 * Add a response pattern.
	 */
	addResponse(pattern: RegExp | string, response: string | MockLLMHandler): void {
		if (!this.config.responses) {
			this.config.responses = new Map();
		}
		this.config.responses.set(pattern, response);
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-configured Mock LLMs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a mock LLM for interview question generation.
 */
export function createInterviewMockLLM(): MockLLM {
	return new MockLLM({
		responses: new Map([
			[/generate.*question/i, JSON.stringify({
				questions: [
					{ type: "text", question: "What is the main goal?", id: "q1" },
					{ type: "select", question: "Framework?", options: ["React", "Vue", "Svelte"], id: "q2" },
				],
				isComplete: false,
			})],
			[/analyze.*interview/i, JSON.stringify({
				isComplete: true,
				nextQuestions: [],
				roundType: "clarification",
			})],
		]),
	});
}

/**
 * Create a mock LLM for scout phase.
 */
export function createScoutMockLLM(): MockLLM {
	return new MockLLM({
		responses: new Map([
			[/scout|context|codebase/i, `
<meta>
# Planning Guidance
## Architecture Analysis
Current project uses TypeScript with Express.
## Integration Points
| File | Action |
|------|--------|
| src/types.ts | Modify |
| src/routes/auth.ts | Create |
</meta>

<file_map>
src/
├── types.ts
├── routes/
│   └── index.ts
</file_map>

<file_contents>
File: src/types.ts
\`\`\`typescript
export interface User {
  id: string;
}
\`\`\`
</file_contents>
`],
		]),
	});
}

/**
 * Create a mock LLM for elaborate phase.
 */
export function createElaborateMockLLM(): MockLLM {
	return new MockLLM({
		responses: new Map([
			[/elaborate|plan|implementation/i, `
# Implementation Plan

## Summary
Add authentication to the API.

## Technical Approach
Use JWT tokens stored in httpOnly cookies.

## Implementation Steps

### 1. Create Auth Types
Add User, Token, and Session interfaces to src/types.ts.

### 2. Create JWT Utilities
Implement sign() and verify() functions in src/auth/jwt.ts.

### 3. Add Auth Middleware
Create authentication middleware in src/middleware/auth.ts.

### 4. Add Auth Routes
Create login/logout endpoints in src/routes/auth.ts.

## Testing Strategy
Unit tests for JWT utilities, integration tests for routes.
`],
		]),
	});
}

/**
 * Create a mock LLM for structure phase.
 */
export function createStructureMockLLM(): MockLLM {
	return new MockLLM({
		responses: new Map([
			[/structure|task|TASK-/i, `
# Auth Implementation

---

## TASK-01: Create auth types
Priority: P1
Files: src/types.ts (modify)
Depends on: none
Acceptance: Exports User, Token, Session interfaces

## TASK-02: Implement JWT utilities
Priority: P1
Files: src/auth/jwt.ts (create)
Depends on: TASK-01
Acceptance: sign() and verify() functions work correctly

## TASK-03: Add auth middleware
Priority: P2
Files: src/middleware/auth.ts (create)
Depends on: TASK-02
Acceptance: Middleware validates JWT and sets req.user
`],
		]),
	});
}

/**
 * Create a mock LLM for reviewer.
 */
export function createReviewerMockLLM(issues: Array<{ file: string; description: string }> = []): MockLLM {
	return new MockLLM({
		responses: new Map([
			[/review|check|verify/i, JSON.stringify({
				issues: issues.map((issue, i) => ({
					id: `issue-${i + 1}`,
					file: issue.file,
					severity: "error",
					category: "bug",
					description: issue.description,
				})),
				summary: issues.length === 0 ? "No issues found." : `Found ${issues.length} issues.`,
			})],
		]),
	});
}

/**
 * Create a mock LLM that always succeeds with no issues.
 */
export function createPassingReviewerMockLLM(): MockLLM {
	return createReviewerMockLLM([]);
}

/**
 * Create a mock LLM that finds issues.
 */
export function createFailingReviewerMockLLM(): MockLLM {
	return createReviewerMockLLM([
		{ file: "src/index.ts", description: "Missing error handling" },
		{ file: "src/utils.ts", description: "Type mismatch on line 42" },
	]);
}
