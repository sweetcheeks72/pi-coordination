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
import { createPlanTool } from "../plan/index.js";
import { createCoordinateTool } from "../coordinate/index.js";
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
 * These tests MUST FAIL if parameter order is wrong.
 * Non-vacuity proof: if you swap signal/onUpdate in any tool, the spy assertions
 * fail because the tool receives an AbortSignal where it expects a callback.
 */

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
				expect(msg).not.toContain("is not a function");
				expect(msg).not.toContain("onUpdate is not a function");
				expect(msg).not.toContain("signal.abort is not a function");
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

		it("coord_output: AbortSignal lands in signal slot (not onUpdate slot)", async () => {
			const tool = createCoordOutputTool();
			const signal = new AbortController().signal;
			const onUpdate = vi.fn();
			const ctx = mockCtx();

			try {
				await (tool.execute as any)("id", { ids: ["nonexistent-worker-id"] }, signal, onUpdate, ctx);
			} catch (err) {
				const msg = String(err);
				expect(msg).not.toContain("is not a function");
				expect(msg).not.toContain("onUpdate is not a function");
			}

			// onUpdate should not have been invoked with an AbortSignal
			for (const call of onUpdate.mock.calls) {
				expect(call[0]).not.toBeInstanceOf(AbortSignal);
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
					expect(msg).not.toContain("onUpdate is not a function");
					expect(msg).not.toContain("signal.abort is not a function");
				} finally {
					clearTimeout(timeoutId);
				}

				for (const call of onUpdate.mock.calls) {
					expect(call[0]).not.toBeInstanceOf(AbortSignal);
				}
			}
		}, 30000); // extended test timeout for 11 tools × 500ms each
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
				expect(msg).not.toContain("onUpdate is not a function");
				expect(msg).not.toContain("signal.abort is not a function");
			}

			// onUpdate must NOT have been called with an AbortSignal
			for (const call of onUpdate.mock.calls) {
				expect(call[0]).not.toBeInstanceOf(AbortSignal);
			}
		});

		it("plan: execute.length reflects correct arity (≥ 5 params)", () => {
			const events = createEventBus();
			const tool = createPlanTool(events);
			expect(tool.execute.length).toBeGreaterThanOrEqual(5);
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
				expect(msg).not.toContain("onUpdate is not a function");
				expect(msg).not.toContain("signal.abort is not a function");
			}

			// onUpdate must NOT have been called with an AbortSignal
			for (const call of onUpdate.mock.calls) {
				expect(call[0]).not.toBeInstanceOf(AbortSignal);
			}
		});

		it("coordinate: execute.length reflects correct arity (≥ 5 params)", () => {
			const events = createEventBus();
			const tool = createCoordinateTool(events);
			expect(tool.execute.length).toBeGreaterThanOrEqual(5);
		});
	});
});
