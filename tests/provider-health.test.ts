#!/usr/bin/env npx jiti
import { TestRunner, assertEqual, assert } from "./test-utils.js";
import { buildParentModelEnv, classifyProviderFailure, estimateProviderCooldownMs, parseModelCandidates, resolveParentModelHint, selectModelCandidate, type ProviderAttemptRecord } from "../subagent/provider-health.js";

async function main() {
	const runner = new TestRunner();
	runner.section("Provider health");

	await runner.test("parses comma-separated model candidates", () => {
		assertEqual(parseModelCandidates("anthropic/claude-sonnet-4-6, openai-codex/gpt-5.4, google/gemini-2.5-flash").length, 3);
	});

	await runner.test("classifies rate-limit failures", () => {
		assertEqual(classifyProviderFailure('429 {"type":"error","error":{"type":"rate_limit_error"}}'), "rate_limit");
	});

	await runner.test("learns cooldown from recovery history", () => {
		const history: ProviderAttemptRecord[] = [
			{ timestamp: 0, provider: "anthropic", status: "rate_limit" },
			{ timestamp: 10 * 60 * 1000, provider: "anthropic", status: "success" },
			{ timestamp: 20 * 60 * 1000, provider: "anthropic", status: "rate_limit" },
			{ timestamp: 30 * 60 * 1000, provider: "anthropic", status: "success" },
		];
		assertEqual(estimateProviderCooldownMs("anthropic", history, 35 * 60 * 1000), 10 * 60 * 1000);
	});

	await runner.test("resolves explicit parent model over env model", () => {
		assertEqual(resolveParentModelHint("openai-codex/gpt-5.4", "anthropic/claude-sonnet-4-6"), "openai-codex/gpt-5.4");
	});

	await runner.test("falls back to env parent model when explicit parent missing", () => {
		assertEqual(resolveParentModelHint(undefined, "google/gemini-2.5-flash"), "google/gemini-2.5-flash");
	});


	await runner.test("builds child env with PI_MODEL when parent provided", () => {
		const env = buildParentModelEnv({ PATH: "x" } as NodeJS.ProcessEnv, "openai-codex/gpt-5.4");
		assertEqual(env.PI_MODEL, "openai-codex/gpt-5.4");
		assertEqual(env.PATH, "x");
	});

	await runner.test("leaves child env untouched when parent missing", () => {
		const env = buildParentModelEnv({ PATH: "x" } as NodeJS.ProcessEnv, undefined);
		assertEqual(env.PI_MODEL, undefined);
		assertEqual(env.PATH, "x");
	});
	await runner.test("prefers parent provider lane when available", () => {
		const sel = selectModelCandidate("anthropic/claude-sonnet-4-6, openai-codex/gpt-5.4, google/gemini-2.5-flash", "openai-codex/gpt-5.4", Date.now(), "/tmp/nonexistent-provider-health-history.jsonl");
		assertEqual(sel.selectedModel, "openai-codex/gpt-5.4");
	});

	await runner.test("reports blocked models when cooling down", () => {
		const temp = "/tmp/provider-health-test-history.jsonl";
		require("node:fs").writeFileSync(temp, JSON.stringify({ timestamp: Date.now(), provider: "openai", model: "openai-codex/gpt-5.4", status: "rate_limit" }) + "\n");
		const sel = selectModelCandidate("openai-codex/gpt-5.4, google/gemini-2.5-flash", "openai-codex/gpt-5.4", Date.now(), temp);
		assert(sel.blockedModels.length >= 1, "expected at least one blocked model");
		require("node:fs").unlinkSync(temp);
	});

	await runner.summary();
}

main().catch(console.error);
