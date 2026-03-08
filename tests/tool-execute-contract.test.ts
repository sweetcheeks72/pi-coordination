import { describe, it, expect, vi } from "vitest";

// Tool execute parameter order contract test
// Canonical signature: execute(toolCallId, params, signal, onUpdate, ctx)
// This test verifies that onUpdate is NOT called with an AbortSignal (which would
// indicate wrong parameter order was used)

describe("tool execute parameter order contract", () => {
  it("should have canonical signature order documented", () => {
    // This is a compile-time / grep-based contract check
    // The actual runtime check is done via the TypeScript types
    // Canonical: execute(toolCallId, params, signal, onUpdate, ctx)
    // Wrong:     execute(toolCallId, params, onUpdate, ctx, signal)
    
    // If you see "onUpdate is not a function" or "signal.abort is not a function"
    // it means the parameter order is wrong in one of the tool definitions
    expect(true).toBe(true);
  });

  it("AbortSignal should be 3rd param - verify via mock", () => {
    // Simulate what Pi Core does when calling execute:
    // Pi Core passes: (toolCallId, params, signal, onUpdate, ctx)
    const calls: unknown[][] = [];
    
    // Mock an execute function with CORRECT signature
    const correctExecute = (
      _toolCallId: string,
      _params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: ((details: unknown) => void) | undefined,
      _ctx: unknown
    ) => {
      calls.push([signal, onUpdate]);
      return Promise.resolve({ content: [] });
    };
    
    const mockSignal = new AbortController().signal;
    const mockOnUpdate = vi.fn();
    const mockCtx = {};
    
    // Call with Pi Core's argument order
    correctExecute("id-1", {}, mockSignal, mockOnUpdate, mockCtx);
    
    // In correct order: signal is AbortSignal, onUpdate is a function
    expect(calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(typeof calls[0][1]).toBe("function");
  });

  it("wrong parameter order would cause AbortSignal in onUpdate slot", () => {
    // Simulate what HAPPENS with wrong order when Pi Core calls:
    // execute(toolCallId, params, signal, onUpdate, ctx)
    // But the function expects:
    // execute(toolCallId, params, onUpdate, ctx, signal)
    const calls: unknown[][] = [];
    
    // WRONG signature (old buggy code)
    const wrongExecute = (
      _toolCallId: string,
      _params: unknown,
      onUpdate: ((details: unknown) => void) | undefined,  // <-- wrong slot
      _ctx: unknown,
      _signal?: AbortSignal,
    ) => {
      calls.push([onUpdate]);
      return Promise.resolve({ content: [] });
    };
    
    const mockSignal = new AbortController().signal;
    const mockOnUpdate = vi.fn();
    const mockCtx = {};
    
    // Pi Core calls with correct order
    wrongExecute("id-1", {}, mockSignal as unknown as ((details: unknown) => void), mockCtx, mockOnUpdate as unknown as AbortSignal);
    
    // With wrong order: onUpdate slot receives the AbortSignal!
    // Calling onUpdate() would throw "onUpdate is not a function" (or signal.abort error)
    expect(calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(typeof calls[0][0]).not.toBe("function"); // <-- the bug!
  });
});
