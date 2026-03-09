#!/usr/bin/env npx jiti
/**
 * Model Resolution Tests
 * 
 * Verifies that model resolution follows: param > agent frontmatter > defaultModel
 * 
 * Run with: npx jiti tests/model-resolution.test.ts
 */

import { discoverAgents, type AgentConfig } from "../subagent/agents.js";
import { TestRunner, assertEqual } from "./test-utils.js";

async function main() {
	const runner = new TestRunner();
	
	runner.section("Model Resolution");
	
	// Helper that mirrors the coordinate function's logic
	const getAgentModel = (agents: AgentConfig[], name: string): string | undefined => 
		agents.find(a => a.name === name)?.model;
	
	const resolveModel = (
		agents: AgentConfig[],
		agentName: string,
		paramModel: string | undefined,
		defaultModel: string | undefined
	): string | undefined => {
		return paramModel || getAgentModel(agents, agentName) || defaultModel;
	};
	
	// Discover actual agents
	const { agents } = discoverAgents(process.cwd(), "user");
	
	await runner.test("discovers coordination/scout agent", () => {
		const scout = agents.find(a => a.name === "coordination/scout");
		assertEqual(!!scout, true, "coordination/scout agent should exist");
	});
	
	await runner.test("coordination/scout has frontmatter model", () => {
		const scout = agents.find(a => a.name === "coordination/scout");
		assertEqual(!!scout?.model, true, "coordination/scout should have a model in frontmatter");
		console.log(`    → frontmatter model: ${scout?.model}`);
	});
	
	await runner.test("param takes precedence over frontmatter", () => {
		const result = resolveModel(agents, "coordination/scout", "param-model", "default-model");
		assertEqual(result, "param-model");
	});
	
	await runner.test("frontmatter takes precedence over defaultModel", () => {
		const scout = agents.find(a => a.name === "coordination/scout");
		const result = resolveModel(agents, "coordination/scout", undefined, "default-model");
		assertEqual(result, scout?.model, "should use frontmatter model, not default");
		console.log(`    → resolved to: ${result} (frontmatter), not default-model`);
	});
	
	await runner.test("defaultModel used when no param and no frontmatter", () => {
		// Use a non-existent agent to simulate no frontmatter
		const result = resolveModel(agents, "non-existent-agent", undefined, "default-model");
		assertEqual(result, "default-model");
	});
	
	await runner.test("undefined when nothing set", () => {
		const result = resolveModel(agents, "non-existent-agent", undefined, undefined);
		assertEqual(result, undefined);
	});
	
	// Test all coordination agents have models
	runner.section("Agent Frontmatter Models");
	
	const coordinationAgents = [
		{ name: "coordination/scout", label: "scout", required: true },
		{ name: "coordination/planner", label: "planner", required: true },
		{ name: "coordination/coordinator", label: "coordinator", required: false },
		{ name: "coordination/worker", label: "worker", required: true },
		{ name: "coordination/reviewer", label: "reviewer", required: true },
	];
	
	for (const { name, label, required } of coordinationAgents) {
		await runner.test(`${label} agent ${required ? "exists" : "presence recorded"}`, () => {
			const agent = agents.find(a => a.name === name);
			if (required) assertEqual(!!agent, true, `${name} should exist`);
			else console.log(`    → optional agent ${name}: ${agent ? "present" : "absent"}`);
		});
	}
	
	console.log("\n📋 Discovered agent models:");
	for (const { name, label } of coordinationAgents) {
		const agent = agents.find(a => a.name === name);
		console.log(`   ${label.padEnd(12)} → ${agent?.model || "(no model)"}`);
	}
	
	await runner.summary();
}

main().catch(console.error);
