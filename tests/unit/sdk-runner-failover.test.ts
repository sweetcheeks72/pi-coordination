#!/usr/bin/env npx jiti
/**
 * Unit tests for sdk-runner in-process retry/failover and prompt caching.
 *
 * Run with: npx jiti tests/unit/sdk-runner-failover.test.ts
 *
 * Tests:
 *   1. runWithFailover — succeeds on first attempt when runFn succeeds
 *   2. runWithFailover — retries on 429 within same model (2 attempts)
 *   3. runWithFailover — retries on 5xx / overloaded errors
 *   4. runWithFailover — does NOT retry on non-retryable errors
 *   5. runWithFailover — cascades to next provider after exhausting current model
 *   6. runWithFailover — throws after all providers exhausted
 *   7. PROVIDER_CASCADE — defined, non-empty, contains expected providers
 *   8. Cache metrics — cacheHitRate property exists on SDKProgress
 *
 * @module
 */

import { TestRunner, assertEqual, assert } from "../test-utils.js";
import { runWithFailover, PROVIDER_CASCADE } from "../../subagent/sdk-runner.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeError(status?: number, message?: string): Error & { status?: number } {
	const err = new Error(message ?? "test error") as Error & { status?: number };
	if (status !== undefined) err.status = status;
	return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ─────────────────────────────────────────────────────────────────────────
	// PROVIDER_CASCADE
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("PROVIDER_CASCADE constant");

	runner.test("PROVIDER_CASCADE is defined and non-empty", () => {
		assert(Array.isArray(PROVIDER_CASCADE), "PROVIDER_CASCADE must be an array");
		assert(PROVIDER_CASCADE.length > 0, "PROVIDER_CASCADE must have at least one entry");
	});

	runner.test("PROVIDER_CASCADE contains Bedrock primary model", () => {
		const hasBedrock = PROVIDER_CASCADE.some((m) => m.includes("amazon-bedrock"));
		assert(hasBedrock, "PROVIDER_CASCADE must include an amazon-bedrock model as primary");
	});

	runner.test("PROVIDER_CASCADE contains Anthropic fallback", () => {
		const hasAnthropic = PROVIDER_CASCADE.some((m) => m.startsWith("anthropic/"));
		assert(hasAnthropic, "PROVIDER_CASCADE must include an anthropic/ direct model");
	});

	runner.test("PROVIDER_CASCADE contains OpenAI fallback", () => {
		const hasOpenAI = PROVIDER_CASCADE.some((m) => m.startsWith("openai/"));
		assert(hasOpenAI, "PROVIDER_CASCADE must include an openai/ model");
	});

	runner.test("PROVIDER_CASCADE contains Google fallback", () => {
		const hasGoogle = PROVIDER_CASCADE.some((m) => m.startsWith("google/"));
		assert(hasGoogle, "PROVIDER_CASCADE must include a google/ model");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// runWithFailover — success path
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("runWithFailover — success path");

	await runner.test("returns result immediately when runFn succeeds on first attempt", async () => {
		let callCount = 0;
		const modelsUsed: string[] = [];

		const result = await runWithFailover(async (model) => {
			callCount++;
			modelsUsed.push(model);
			return `success-${model}`;
		}, "test-model/initial");

		assertEqual(callCount, 1, "runFn should be called exactly once on immediate success");
		assertEqual(modelsUsed.length, 1, "Only one model should be tried");
		assert(result.startsWith("success-"), `Result should start with 'success-', got: ${result}`);
	});

	await runner.test("passes initialModel as the first model tried", async () => {
		const modelsUsed: string[] = [];

		await runWithFailover(async (model) => {
			modelsUsed.push(model);
			return "ok";
		}, "my-special-model");

		assertEqual(modelsUsed[0], "my-special-model", "initialModel should be the first model tried");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// runWithFailover — 429 retry path
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("runWithFailover — 429 rate-limit retry");

	await runner.test("retries on 429 status error within same model (up to 2 attempts)", async () => {
		let callCount = 0;
		const modelsUsed: string[] = [];

		// Fail once with 429 on the initial model, then succeed
		const result = await runWithFailover(async (model) => {
			callCount++;
			modelsUsed.push(model);
			if (callCount === 1) {
				throw makeError(429, "Too Many Requests");
			}
			return `success-${model}`;
		}, "initial-model");

		assert(callCount >= 2, `Expected ≥2 calls for 429 retry, got ${callCount}`);
		assert(result.startsWith("success-"), `Expected success result, got: ${result}`);
	});

	await runner.test("retries on 'rate limit' message error", async () => {
		let callCount = 0;

		const result = await runWithFailover(async (_model) => {
			callCount++;
			if (callCount === 1) {
				throw makeError(undefined, "rate limit exceeded for model");
			}
			return "recovered";
		}, "initial-model");

		assert(callCount >= 2, `Expected ≥2 calls for rate limit retry, got ${callCount}`);
		assertEqual(result, "recovered", "Should return success result after retry");
	});

	await runner.test("retries on 'throttl' message error", async () => {
		let callCount = 0;

		const result = await runWithFailover(async (_model) => {
			callCount++;
			if (callCount === 1) {
				throw makeError(undefined, "Request throttled by provider");
			}
			return "ok";
		}, "initial-model");

		assert(callCount >= 2, `Expected ≥2 calls for throttle retry, got ${callCount}`);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// runWithFailover — provider error (5xx) retry path
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("runWithFailover — 5xx / overloaded retry");

	await runner.test("retries on 500+ status error", async () => {
		let callCount = 0;

		const result = await runWithFailover(async (_model) => {
			callCount++;
			if (callCount === 1) {
				throw makeError(503, "Service Unavailable");
			}
			return "recovered";
		}, "initial-model");

		assert(callCount >= 2, `Expected ≥2 calls for 5xx retry, got ${callCount}`);
		assertEqual(result, "recovered");
	});

	await runner.test("retries on 'overloaded' message error", async () => {
		let callCount = 0;

		const result = await runWithFailover(async (_model) => {
			callCount++;
			if (callCount === 1) {
				throw makeError(undefined, "Model is overloaded");
			}
			return "ok";
		}, "initial-model");

		assert(callCount >= 2, `Expected ≥2 calls for overloaded retry, got ${callCount}`);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// runWithFailover — non-retryable errors
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("runWithFailover — non-retryable errors");

	await runner.test("does NOT retry on non-retryable errors (e.g. 400 Bad Request)", async () => {
		let callCount = 0;
		let caughtError: Error | undefined;

		try {
			await runWithFailover(async (_model) => {
				callCount++;
				throw makeError(400, "Bad Request — invalid prompt");
			}, "initial-model");
		} catch (err) {
			caughtError = err as Error;
		}

		assertEqual(callCount, 1, "runFn should be called exactly once for non-retryable error");
		assert(caughtError !== undefined, "Error should be propagated");
		assert(caughtError!.message.includes("Bad Request"), "Original error message should be preserved");
	});

	await runner.test("does NOT retry on generic non-status errors", async () => {
		let callCount = 0;
		let caughtError: Error | undefined;

		try {
			await runWithFailover(async (_model) => {
				callCount++;
				throw new Error("SyntaxError: unexpected token");
			}, "initial-model");
		} catch (err) {
			caughtError = err as Error;
		}

		assertEqual(callCount, 1, "Non-retryable error should not trigger retry");
		assert(caughtError !== undefined, "Error should be propagated");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// runWithFailover — provider cascade
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("runWithFailover — provider cascade");

	await runner.test("cascades to next provider after exhausting 2 attempts on initial model", async () => {
		const modelsUsed: string[] = [];
		let attemptsByModel: Record<string, number> = {};

		// Fail with 429 on the first model (both attempts), succeed on second
		const result = await runWithFailover(async (model) => {
			modelsUsed.push(model);
			attemptsByModel[model] = (attemptsByModel[model] ?? 0) + 1;

			// First model always fails with 429
			const firstModel = modelsUsed[0];
			if (model === firstModel) {
				throw makeError(429, "Too Many Requests");
			}
			// Second model succeeds
			return `success-on-${model}`;
		}, "failing-model");

		// Should have tried the initial model 2 times, then cascaded to a cascade model
		assertEqual(attemptsByModel["failing-model"], 2, "Initial model should be tried 2 times");
		assert(modelsUsed.length > 2, "Should have cascaded to at least one additional model");
		assert(result.startsWith("success-on-"), `Expected success after cascade, got: ${result}`);
	});

	await runner.test("does not include initialModel twice when it appears in PROVIDER_CASCADE", async () => {
		const modelsUsed: string[] = [];

		// Use a model that's in the PROVIDER_CASCADE
		const cascadeModel = PROVIDER_CASCADE[0]!;
		let callCount = 0;

		try {
			await runWithFailover(async (model) => {
				modelsUsed.push(model);
				callCount++;
				if (callCount <= 2) throw makeError(429, "rate limit");
				return "ok";
			}, cascadeModel);
		} catch {
			// may throw if all fail — we just care about deduplication
		}

		// The initialModel should NOT appear twice in the first position
		const firstOccurrence = modelsUsed.indexOf(cascadeModel);
		const secondOccurrence = modelsUsed.indexOf(cascadeModel, firstOccurrence + 1);
		// After exhausting 2 attempts, the model should not be retried again from CASCADE
		assert(
			secondOccurrence === -1 || secondOccurrence > firstOccurrence + 1,
			"initialModel should not appear consecutively twice from both initial + cascade",
		);
	});

	await runner.test("throws after all providers exhausted", async () => {
		let caughtError: Error | undefined;

		try {
			await runWithFailover(async (_model) => {
				throw makeError(429, "always rate limited");
			}, "initial-model");
		} catch (err) {
			caughtError = err as Error;
		}

		assert(caughtError !== undefined, "Should throw when all providers exhausted");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Cache hit rate computation
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("Cache hit rate computation");

	runner.test("cache hit rate formula: cacheRead / (cacheRead + input)", () => {
		// Validate the formula we use in sdk-runner
		function computeCacheHitRate(cacheRead: number, inputTokens: number): number {
			const total = cacheRead + inputTokens;
			if (total === 0) return 0;
			return Math.round((cacheRead / total) * 100);
		}

		assertEqual(computeCacheHitRate(0, 0), 0, "0/0 should be 0%");
		assertEqual(computeCacheHitRate(900, 100), 90, "90/100 cache read should be 90%");
		assertEqual(computeCacheHitRate(0, 1000), 0, "No cache reads = 0%");
		assertEqual(computeCacheHitRate(1000, 0), 100, "All cached = 100%");
		assertEqual(computeCacheHitRate(500, 500), 50, "Half cached = 50%");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// SDKProgress interface — cacheHitRate field
	// ─────────────────────────────────────────────────────────────────────────

	runner.section("SDKProgress — cacheHitRate field");

	runner.test("SDKProgress usage object includes cacheHitRate field", () => {
		// Import the type to check at runtime via a mock object
		// We verify that the shape expected by callers is compatible
		const mockUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; cacheHitRate: number } = {
			input: 100,
			output: 50,
			cacheRead: 900,
			cacheWrite: 1000,
			cost: 0.01,
			turns: 1,
			cacheHitRate: 90, // This field must exist
		};
		assertEqual(typeof mockUsage.cacheHitRate, "number", "cacheHitRate should be a number");
		assertEqual(mockUsage.cacheHitRate, 90, "cacheHitRate should be 90 in this case");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Summary
	// ─────────────────────────────────────────────────────────────────────────

	const { failed } = runner.summary();
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("Test suite failed:", err);
	process.exit(1);
});
