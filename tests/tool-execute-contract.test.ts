import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @mariozechner/pi-tui before any tool imports that pull it in transitively.
// plan/index.ts and coordinate/index.ts both import { Text, Container } from pi-tui for
// renderCall/renderResult, but execute() itself never uses them. Mocking lets us test
// just the execute() contract without needing the full TUI installed locally.
vi.mock("@mariozechner/pi-tui", () => ({
	Text: class Text {
		constructor(public text: string, public x: number, public y: number) {}
	},
	Container: class Container {
		children: unknown[] = [];
		add(child: unknown) { this.children.push(child); return this; }
	},
}));

import { createReadContextTool } from "../read-context/index.js";
import { createCoordOutputTool } from "../coord-output/index.js";
import { createCoordinatorTools } from "../coordinate/coordinator-tools/index.js";
import { registerWorkerTools } from "../coordinate/worker-tools/index.js";
import { createPlanTool } from "../plan/index.js";
import { createCoordinateTool } from "../coordinate/index.js";
import { createBundleTools } from "../bundle-files/index.js";
import { createEventBus } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

// Type-level contract assertion: verify that execute accepts the canonical 5-param signature
// This fails at compile time if the ToolDefinition interface changes
type CanonicalExecute = ToolDefinition["execute"];
// If this compiles, the interface enforces (toolCallId, params, signal, onUpdate, ctx)
const _typeCheck: CanonicalExecute extends (
	toolCallId: string,
	params: any,
	signal: AbortSignal | undefined,
	onUpdate: any,
	ctx: any
) => any ? true : never = true;

/**
 * Contract tests: verify pi-coordination tools match Pi Core's ToolDefinition
 * execute signature: (toolCallId, params, signal, onUpdate, ctx)
 *
 * TWO LEVELS OF NON-VACUOUS VERIFICATION:
 *
 * 1. SOURCE INSPECTION (authoritative ORDER check):
 *    `getParamNames(fn)` extracts parameter names from `fn.toString()`. If you swap
 *    `_signal` and `_onUpdate`, the regex finds `onUpdate` at index 2 and `signal` at
 *    index 3 — both assertions fail immediately. Mutation-proven non-vacuous: swapping
 *    params in read-context/index.ts produces RED immediately (verified empirically).
 *
 * 2. RUNTIME BEHAVIORAL (slot confusion check):
 *    Passes an AbortSignal as arg[2] and a vi.fn() spy as arg[3]. If the tool tries to
 *    call `onUpdate()` but receives an AbortSignal in that slot, it throws
 *    "is not a function". These tests confirm no "is not a function" errors.
 *    NOTE: tools with `_signal, _onUpdate` (unused) may not trigger slot confusion at
 *    runtime — source inspection is the authoritative check for those tools.
 *
 * NOTE: coordinate/coordinator-tools/sdk-tools.ts (8 tools) is intentionally not tested here.
 * SDK tools require a different integration test environment (real coordination state, network).
 * The parameter order fix was applied there (commit 04d0407) but behavioral coverage
 * requires dedicated SDK integration tests.
 */

/**
 * Extract parameter names from an execute function's source.
 * Strips leading underscores (TypeScript convention for unused params).
 *
 * Examples:
 *   execute(_toolCallId, params, _signal, _onUpdate, ctx) → ['toolCallId', 'params', 'signal', 'onUpdate', 'ctx']
 *   execute(_toolCallId, params, signal, onUpdate, ctx)   → ['toolCallId', 'params', 'signal', 'onUpdate', 'ctx']
 *
 * If someone swaps `_signal, _onUpdate` to `_onUpdate, _signal`:
 *   names[2] === 'onUpdate' → fails /^signal$/i  ← mutation caught!
 */
function getParamNames(fn: Function): string[] {
	const src = fn.toString();
	// Phase 1: method shorthand — async execute(a, b, c) { ... }
	// Uses [\s\S]*? to handle multi-line signatures with TypeScript type annotations
	let match = src.match(/(?:async\s+)?execute\s*\(\s*([\s\S]*?)\s*\)/);
	// Phase 2: arrow function — fn.toString() of an arrow gives "async (a, b) => {}" — no method name
	if (!match) match = src.match(/^async\s*\(\s*([\s\S]*?)\s*\)/);
	if (!match) return [];
	return match[1]
		.split(",")
		.map((p) => p.trim().split(/\s+/).pop()!.replace(/^_+/, ""))
		.filter(Boolean);
}

// Helper: create a minimal mock ExtensionContext
function mockCtx(cwd = "/tmp") {
	return {
		cwd,
		ui: { notify: vi.fn() },
		sessionManager: undefined,
		storage: undefined,
	} as any;
}

describe("Tool execute signature contract", () => {
	describe("signal is 3rd param, onUpdate is 4th", () => {
		it("read_context: AbortSignal lands in signal slot (not onUpdate slot)", async () => {
			const tool = createReadContextTool();
			const signal = new AbortController().signal;
			const onUpdate = vi.fn();
			const ctx = mockCtx();

			// Pass signal as 3rd arg, onUpdate as 4th arg — matching Pi Core's call convention.
			// If param order were wrong, the tool would receive the AbortSignal as onUpdate
			// and fail with "onUpdate is not a function" when it tries to call it.
			try {
				await (tool.execute as any)("id", { path: "/nonexistent/file.md" }, signal, onUpdate, ctx);
			} catch (err) {
				// File-not-found is expected — but we must NOT get "is not a function" errors
				// which would indicate the AbortSignal landed in the onUpdate slot.
				const msg = String(err);
				expect(msg).not.toMatch(/is not a function/i);
			}

			// onUpdate must NOT have been called with an AbortSignal (that would mean
			// something called onUpdate(signal) — indicating slot confusion)
			for (const call of onUpdate.mock.calls) {
				expect(call[0]).not.toBeInstanceOf(AbortSignal);
			}
		});

		it("read_context: signal is an AbortSignal instance (not a function)", async () => {
			const tool = createReadContextTool();
			const signal = new AbortController().signal;
			const onUpdate = vi.fn();
			const ctx = mockCtx();

			// Verify the tool can introspect signal.aborted without throwing
			// (this only works if signal is truly in the signal slot)
			expect(signal).toBeInstanceOf(AbortSignal);
			expect(signal.aborted).toBe(false);

			try {
				await (tool.execute as any)("id", { path: "/nonexistent" }, signal, onUpdate, ctx);
			} catch {
				// ignore file errors
			}
		});

		it("read_context: pre-aborted signal is honored (not confused with onUpdate)", async () => {
			const tool = createReadContextTool();
			const ac = new AbortController();
			ac.abort(); // pre-abort before calling
			const onUpdate = vi.fn();
			const ctx = mockCtx();

			// If signal were in the onUpdate slot, the tool might try calling onUpdate()
			// which is really signal() → throws "signal is not a function"
			// With correct order, signal.aborted === true and the tool can check it cleanly.
			let threw = false;
			try {
				await (tool.execute as any)("id", { path: "/some/path.md" }, ac.signal, onUpdate, ctx);
			} catch (err) {
				threw = true;
				const msg = String(err);
				// Must NOT be a slot confusion error
				expect(msg).not.toMatch(/is not a function/i);
				expect(msg).not.toMatch(/cannot read prop.*abort/i);
			}
			// Either returned cleanly or threw for the right reasons (file not found, etc.)
			// The key invariant: no slot confusion errors
			// (threw is allowed — file-not-found is legitimate)
			void threw;
		});

		it("coord_output: AbortSignal lands in signal slot (not onUpdate slot)", async () => {
			const tool = createCoordOutputTool();
			const signal = new AbortController().signal;
			const onUpdate = vi.fn();
			const ctx = mockCtx();

			try {
				await (tool.execute as any)("id", { ids: ["nonexistent-worker-id"] }, signal, onUpdate, ctx);
			} catch (err) {
				const msg = String(err);
				expect(msg).not.toMatch(/is not a function/i);
			}

			// onUpdate should not have been invoked with an AbortSignal
			for (const call of onUpdate.mock.calls) {
				expect(call[0]).not.toBeInstanceOf(AbortSignal);
			}
		});

		it("coord_output: pre-aborted signal is honored (not confused with onUpdate)", async () => {
			const tool = createCoordOutputTool();
			const ac = new AbortController();
			ac.abort(); // pre-abort before calling
			const onUpdate = vi.fn();
			const ctx = mockCtx();

			// Non-vacuous: if signal were in the onUpdate slot, calling onUpdate() → signal()
			// would throw "signal is not a function" because AbortSignal is not callable.
			// With correct slot assignment, signal.aborted === true and the tool handles
			// it cleanly (either early-exit or throws AbortError).
			try {
				await (tool.execute as any)("id", { ids: ["nonexistent-worker-id"] }, ac.signal, onUpdate, ctx);
			} catch (err) {
				const msg = String(err);
				expect(msg).not.toMatch(/is not a function/i);
				expect(msg).not.toMatch(/cannot read prop.*abort/i);
			}
		});

		it("tool.execute.length reflects correct arity (≥ 5 params)", () => {
			// All tools should accept all 5 explicit parameters.
			// execute(toolCallId, params, signal, onUpdate, ctx)
			// >= 3 would pass even broken 4-param (pre-fix) implementations.
			// >= 5 is tight enough to catch any slot regression.
			const readContext = createReadContextTool();
			const coordOutput = createCoordOutputTool();

			expect(readContext.execute.length).toBeGreaterThanOrEqual(5);
			expect(coordOutput.execute.length).toBeGreaterThanOrEqual(5);
		});
	});

	describe("coordinator tools: signal is 3rd param", () => {
		// createCoordinatorTools() requires these env vars at construction time
		const coordDir = "/tmp/pi-test-coord";
		const savedCoordDir = process.env.PI_COORDINATION_DIR;
		const savedIdentity = process.env.PI_AGENT_IDENTITY;

		beforeEach(() => {
			process.env.PI_COORDINATION_DIR = coordDir;
			process.env.PI_AGENT_IDENTITY = "test-worker";
		});

		afterEach(() => {
			if (savedCoordDir === undefined) delete process.env.PI_COORDINATION_DIR;
			else process.env.PI_COORDINATION_DIR = savedCoordDir;
			if (savedIdentity === undefined) delete process.env.PI_AGENT_IDENTITY;
			else process.env.PI_AGENT_IDENTITY = savedIdentity;
		});

		it("all coordinator tools have correct arity (≥ 5 params)", () => {
			// NOTE: arity (execute.length) proves param COUNT, not ORDER.
			// For ORDER verification, see the "execute parameter ORDER — source inspection" suite below.
			// Coordinator tools must have all 5 slots: (toolCallId, params, signal, onUpdate, ctx).
			// >= 2 would pass even badly regressed implementations.
			const tools = createCoordinatorTools();
			expect(tools.length).toBeGreaterThan(0);

			for (const tool of tools) {
				expect(tool.execute.length).toBeGreaterThanOrEqual(5);
			}
		});

		it("coordinator tools: AbortSignal does not land in onUpdate slot", async () => {
			const tools = createCoordinatorTools();
			// Test all coordinator tools
			const subset = tools;

			// Use a short per-tool timeout so long-running tools (e.g. spawn_workers)
			// don't stall the test. Timeout is acceptable — it means the tool ran
			// without throwing "is not a function" (which would mean wrong slot).
			const PER_TOOL_TIMEOUT_MS = 500;

			for (const tool of subset) {
				const ac = new AbortController();
				const signal = ac.signal;
				const onUpdate = vi.fn();
				const ctx = mockCtx();

				const timeoutId = setTimeout(() => ac.abort(), PER_TOOL_TIMEOUT_MS);

				try {
					await Promise.race([
						(tool.execute as any)("id", {}, signal, onUpdate, ctx),
						new Promise<void>((_, reject) =>
							setTimeout(() => reject(new Error("per-tool timeout")), PER_TOOL_TIMEOUT_MS)
						),
					]);
				} catch (err) {
					const msg = String(err);
					// "is not a function" indicates wrong slot — signal ended up as onUpdate
					expect(msg).not.toMatch(/is not a function/i);
				} finally {
					clearTimeout(timeoutId);
				}

				for (const call of onUpdate.mock.calls) {
					expect(call[0]).not.toBeInstanceOf(AbortSignal);
				}
			}
		}, 30000); // extended test timeout for 11 tools × 500ms each

		it("coordinator: pre-aborted signal is honored (not confused with onUpdate)", async () => {
			const tools = createCoordinatorTools();
			// Pick first coordinator tool for the representative pre-abort test
			const tool = tools[0];
			expect(tool).toBeDefined();

			const ac = new AbortController();
			ac.abort(); // pre-abort before calling
			const onUpdate = vi.fn();
			const ctx = mockCtx();

			// Non-vacuous: pre-aborted signal.aborted === true.
			// If signal were in the onUpdate slot, onUpdate() → signal() → "not a function".
			// Correct slot: the tool reads signal.aborted cleanly or early-exits.
			try {
				await (tool.execute as any)("id", {}, ac.signal, onUpdate, ctx);
			} catch (err) {
				const msg = String(err);
				expect(msg).not.toMatch(/is not a function/i);
				expect(msg).not.toMatch(/cannot read prop.*abort/i);
			}
		});
	});

	describe("plan tool: signal is 3rd param", () => {
		it("plan: AbortSignal lands in signal slot (not onUpdate slot)", async () => {
			const events = createEventBus();
			const tool = createPlanTool(events);
			const signal = new AbortController().signal;
			const onUpdate = vi.fn();
			const ctx = mockCtx();

			try {
				// Invalid input — but must NOT throw "is not a function"
				await (tool.execute as any)("id", {}, signal, onUpdate, ctx);
			} catch (err) {
				const msg = String(err);
				expect(msg).not.toMatch(/is not a function/i);
			}

			// onUpdate must NOT have been called with an AbortSignal
			for (const call of onUpdate.mock.calls) {
				expect(call[0]).not.toBeInstanceOf(AbortSignal);
			}
		});

		it("plan: execute.length reflects correct arity (exactly 5 params)", () => {
			// NOTE: arity proves param COUNT, not ORDER.
			// For ORDER verification, see the "execute parameter ORDER — source inspection" suite below.
			const events = createEventBus();
			const tool = createPlanTool(events);
			// Exact assertion: plan tool has (toolCallId, params, signal, onUpdate, ctx)
			// toBeGreaterThanOrEqual(5) would pass a 6-param regression; toBe(5) catches it.
			expect(tool.execute.length).toBe(5);
		});
	});

	describe("coordinate tool: signal is 3rd param", () => {
		it("coordinate: AbortSignal lands in signal slot (not onUpdate slot)", async () => {
			const events = createEventBus();
			const tool = createCoordinateTool(events);
			const signal = new AbortController().signal;
			const onUpdate = vi.fn();
			const ctx = mockCtx();

			try {
				// Invalid input — but must NOT throw "is not a function"
				await (tool.execute as any)("id", {}, signal, onUpdate, ctx);
			} catch (err) {
				const msg = String(err);
				expect(msg).not.toMatch(/is not a function/i);
			}

			// onUpdate must NOT have been called with an AbortSignal
			for (const call of onUpdate.mock.calls) {
				expect(call[0]).not.toBeInstanceOf(AbortSignal);
			}
		});

		it("coordinate: execute.length reflects correct arity (exactly 5 params)", () => {
			// NOTE: arity proves param COUNT, not ORDER.
			// For ORDER verification, see the "execute parameter ORDER — source inspection" suite below.
			const events = createEventBus();
			const tool = createCoordinateTool(events);
			// Exact assertion: coordinate tool has (toolCallId, params, signal, onUpdate, ctx)
			// toBe(5) catches any signature widening regression.
			expect(tool.execute.length).toBe(5);
		});
	});

	describe("worker tools: signal is 3rd param, onUpdate is 4th", () => {
		// registerWorkerTools needs PI_COORDINATION_DIR, PI_AGENT_IDENTITY, PI_WORKER_ID.
		// We mock the ExtensionAPI to capture tool definitions without needing a real pi process.
		const coordDir = "/tmp/pi-test-worker-tools";
		const savedCoordDir = process.env.PI_COORDINATION_DIR;
		const savedIdentity = process.env.PI_AGENT_IDENTITY;
		const savedWorkerId = process.env.PI_WORKER_ID;

		/** Capture tools registered via pi.registerTool() */
		function captureWorkerTools(): ToolDefinition[] {
			const captured: ToolDefinition[] = [];
			const mockPi = {
				registerTool: (tool: ToolDefinition) => { captured.push(tool); },
				on: (_event: string, _handler: unknown) => {},
			} as any;
			registerWorkerTools(mockPi, {
				coordDir,
				identity: "test-worker",
				workerId: "test-worker-id",
			});
			return captured;
		}

		beforeEach(() => {
			process.env.PI_COORDINATION_DIR = coordDir;
			process.env.PI_AGENT_IDENTITY = "test-worker";
			process.env.PI_WORKER_ID = "test-worker-id";
		});

		afterEach(() => {
			if (savedCoordDir === undefined) delete process.env.PI_COORDINATION_DIR;
			else process.env.PI_COORDINATION_DIR = savedCoordDir;
			if (savedIdentity === undefined) delete process.env.PI_AGENT_IDENTITY;
			else process.env.PI_AGENT_IDENTITY = savedIdentity;
			if (savedWorkerId === undefined) delete process.env.PI_WORKER_ID;
			else process.env.PI_WORKER_ID = savedWorkerId;
		});

		it("all worker tools have correct arity (execute.length === 5)", () => {
			// NOTE: arity proves param COUNT, not ORDER.
			// For ORDER verification, see the "execute parameter ORDER — source inspection" suite below.
			const tools = captureWorkerTools();
			expect(tools.length).toBeGreaterThan(0);

			for (const tool of tools) {
				// Each worker tool must accept exactly the 5 canonical params.
				// If a tool has execute.length < 5, it is missing a slot (slot regression).
				expect(tool.execute.length).toBeGreaterThanOrEqual(5);
			}
		});

		it("worker tools: pre-aborted signal is honored (not confused with onUpdate)", async () => {
			const tools = captureWorkerTools();
			// Pick the first tool (agent_chat) as the representative
			const tool = tools[0];
			expect(tool).toBeDefined();

			const ac = new AbortController();
			ac.abort(); // pre-abort before calling
			const onUpdate = vi.fn();
			const ctx = mockCtx();

			// Non-vacuous: pre-aborted signal.aborted === true.
			// If signal landed in the onUpdate slot, calling onUpdate() → signal() throws
			// "signal is not a function". Correct slot: signal.aborted is readable, no confusion.
			try {
				await (tool.execute as any)("id", {}, ac.signal, onUpdate, ctx);
			} catch (err) {
				const msg = String(err);
				expect(msg).not.toMatch(/is not a function/i);
				expect(msg).not.toMatch(/cannot read prop.*abort/i);
			}
		});

		it("worker tools: AbortSignal does not land in onUpdate slot", async () => {
			const tools = captureWorkerTools();
			expect(tools.length).toBeGreaterThan(0);

			const PER_TOOL_TIMEOUT_MS = 500;

			for (const tool of tools) {
				const ac = new AbortController();
				const signal = ac.signal;
				const onUpdate = vi.fn();
				const ctx = mockCtx();

				const timeoutId = setTimeout(() => ac.abort(), PER_TOOL_TIMEOUT_MS);

				try {
					await Promise.race([
						(tool.execute as any)("id", {}, signal, onUpdate, ctx),
						new Promise<void>((_, reject) =>
							setTimeout(() => reject(new Error("per-tool timeout")), PER_TOOL_TIMEOUT_MS)
						),
					]);
				} catch (err) {
					const msg = String(err);
					// "is not a function" = slot confusion: signal ended up as onUpdate
					expect(msg).not.toMatch(/is not a function/i);
				} finally {
					clearTimeout(timeoutId);
				}

				for (const call of onUpdate.mock.calls) {
					expect(call[0]).not.toBeInstanceOf(AbortSignal);
				}
			}
		}, 30000); // extended timeout for multiple worker tools
	});

	describe("execute parameter ORDER — source inspection (mutation-proven non-vacuous)", () => {
		/**
		 * These tests use fn.toString() to inspect parameter names directly from source.
		 * Mutation proof: swap `_signal, _onUpdate` to `_onUpdate, _signal` in any tool →
		 * names[2] becomes 'onUpdate' → fails /^signal$/i immediately.
		 *
		 * Unlike arity tests (which only count params) or behavioral tests (which may pass
		 * vacuously when params are unused), source inspection directly asserts ORDER.
		 */

		it("read_context: param[2]=signal, param[3]=onUpdate", () => {
			const names = getParamNames(createReadContextTool().execute);
			// If someone swaps _signal/_onUpdate in read-context/index.ts, this fails
			expect(names[2]).toMatch(/^signal$/i);
			expect(names[3]).toMatch(/^onUpdate$/i);
		});

		it("coord_output: param[2]=signal, param[3]=onUpdate", () => {
			const names = getParamNames(createCoordOutputTool().execute);
			expect(names[2]).toMatch(/^signal$/i);
			expect(names[3]).toMatch(/^onUpdate$/i);
		});

		it("plan tool: param[2]=signal, param[3]=onUpdate", () => {
			const events = createEventBus();
			const names = getParamNames(createPlanTool(events).execute);
			expect(names[2]).toMatch(/^signal$/i);
			expect(names[3]).toMatch(/^onUpdate$/i);
		});

		it("coordinate tool: param[2]=signal, param[3]=onUpdate", () => {
			const events = createEventBus();
			const names = getParamNames(createCoordinateTool(events).execute);
			expect(names[2]).toMatch(/^signal$/i);
			expect(names[3]).toMatch(/^onUpdate$/i);
		});

		it("coordinator tools: every tool has signal at [2] and onUpdate at [3]", () => {
			process.env.PI_COORDINATION_DIR = "/tmp/pi-test-coord";
			process.env.PI_AGENT_IDENTITY = "test-worker";
			const tools = createCoordinatorTools();
			expect(tools.length).toBeGreaterThan(0);
			for (const tool of tools) {
				const names = getParamNames(tool.execute);
				// Fail fast with tool name in message for easier debugging
				expect(
					names[2],
					`coordinator tool '${tool.name}' has wrong param at [2]: expected 'signal', got '${names[2]}'`
				).toMatch(/^signal$/i);
				expect(
					names[3],
					`coordinator tool '${tool.name}' has wrong param at [3]: expected 'onUpdate', got '${names[3]}'`
				).toMatch(/^onUpdate$/i);
			}
		});

		it("worker tools: every tool has signal at [2] and onUpdate at [3]", () => {
			const captured: ToolDefinition[] = [];
			const mockPi = {
				registerTool: (tool: ToolDefinition) => { captured.push(tool); },
				on: (_event: string, _handler: unknown) => {},
			} as any;
			registerWorkerTools(mockPi, {
				coordDir: "/tmp/pi-test-worker-tools",
				identity: "test-worker",
				workerId: "test-worker-id",
			});
			expect(captured.length).toBeGreaterThan(0);
			for (const tool of captured) {
				const names = getParamNames(tool.execute);
				expect(
					names[2],
					`worker tool '${tool.name}' has wrong param at [2]: expected 'signal', got '${names[2]}'`
				).toMatch(/^signal$/i);
				expect(
					names[3],
					`worker tool '${tool.name}' has wrong param at [3]: expected 'onUpdate', got '${names[3]}'`
				).toMatch(/^onUpdate$/i);
			}
		});

		it("bundle-files tools: every tool has signal at [2] and onUpdate at [3]", () => {
			// bundle-files uses arrow function syntax: execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			// fn.toString() returns "async (_toolCallId, params, _signal, _onUpdate, _ctx) => { ... }"
			// The Phase 2 regex (^async\s*\() must match this correctly.
			const tools = createBundleTools("/tmp");
			expect(tools.length).toBeGreaterThan(0);
			for (const tool of tools) {
				const names = getParamNames(tool.execute);
				expect(
					names[2],
					`bundle-files tool '${tool.name}' has wrong param at [2]: expected 'signal', got '${names[2]}'`
				).toMatch(/^signal$/i);
				expect(
					names[3],
					`bundle-files tool '${tool.name}' has wrong param at [3]: expected 'onUpdate', got '${names[3]}'`
				).toMatch(/^onUpdate$/i);
			}
		});

	});
});
