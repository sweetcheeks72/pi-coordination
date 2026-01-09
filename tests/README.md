# Coordination Tests

Tests for the pi-coordination extension.

## Quick Start

```bash
# Run unit tests (no LLM)
npx jiti tests/unit/spec-parser.test.ts
npx jiti tests/unit/spec-validator.test.ts

# Run observability tests (no LLM)
npx jiti tests/observability.test.ts

# Run model resolution tests (no LLM)
npx jiti tests/model-resolution.test.ts

# Full E2E test with actual coordination (uses LLM, ~$0.10-0.50)
pi "coordinate({ plan: 'tests/fixtures/spec.md', costLimit: 0.50 })"
```

## Test Types

### Unit Tests

#### Spec Parser Tests (~17 tests, <1s)

```bash
npx jiti tests/unit/spec-parser.test.ts
```

Tests spec parsing:
- TASK_ID_PATTERNS regex validation
- Task header parsing
- Priority, files, dependencies parsing
- Subtask parent extraction
- Edge cases (empty spec, etc.)

#### Spec Validator Tests (~18 tests, <1s)

```bash
npx jiti tests/unit/spec-validator.test.ts
```

Tests spec validation:
- Valid spec acceptance
- Circular dependency detection
- Missing dependency detection
- Entry point validation
- Duplicate ID detection
- Warning generation

### Observability Tests (~7 tests, <1s)

```bash
npx jiti tests/observability.test.ts
```

Tests observability infrastructure:
- `execution-info.json` reader
- `events.jsonl` parser (including malformed line handling)
- Phase event categorization
- Cost tracking from events

### Model Resolution Tests (~11 tests, <1s)

```bash
npx jiti tests/model-resolution.test.ts
```

Tests model resolution:
- Agent discovery
- Frontmatter model parsing
- Parameter > frontmatter > default resolution

### E2E Tests (manual, uses LLM)

```bash
# Test with a valid spec (requires TASK-XX format)
pi "coordinate({ plan: 'tests/fixtures/spec.md', costLimit: 0.50 })"
```

Then inspect `execution-info.json` and `events.jsonl` in the coordination directory.

## Test Output

Tests create directories in `tests/output/` for debugging. Old directories (>7 days) are automatically cleaned up on each run.

```
tests/output/
├── execution-reader-2026-01-08T10-30-00/
│   └── execution-info.json
├── events-reader-2026-01-08T10-30-01/
│   └── events.jsonl
└── ...
```

## Fixtures

### Main Fixtures (`fixtures/`)

| File | Description |
|------|-------------|
| `spec.md` | Valid TASK-XX format spec with 2 tasks |

### Spec Fixtures (`fixtures/specs/`)

| File | Description |
|------|-------------|
| `valid-simple.md` | Simple 2-task spec |
| `valid-with-subtasks.md` | Spec with TASK-XX.Y subtasks |
| `valid-with-deps.md` | Spec with multiple dependency chains |
| `invalid-circular.md` | Circular dependencies (TASK-01 → TASK-03 → TASK-02 → TASK-01) |
| `invalid-missing-files.md` | Task without files field |
| `invalid-bad-task-id.md` | Invalid task ID formats |

### Context Fixtures (`fixtures/context/`)

| File | Description |
|------|-------------|
| `partial-progress.md` | Coordination in progress (some tasks done) |
| `with-errors.md` | Coordination with errors |
| `completed.md` | Successfully completed coordination |

## Adding Tests

### Integration Test

```typescript
// In observability.test.ts
await runner.test("my reader test", () => {
  const coordDir = createTestCoordDir("my-test");
  createMockExecutionInfo(coordDir, { taskCount: 5 });
  
  const info = readExecutionInfo(coordDir);
  assertEqual(info.taskCount, 5);
  
  return { coordDir }; // Keep for debugging
});
```

## Test Utilities

### Core Helpers (`test-utils.ts`)

| Function | Description |
|----------|-------------|
| `readExecutionInfo(dir)` | Parse `execution-info.json` |
| `readEvents(dir)` | Parse `events.jsonl` |
| `getPhaseEvents(dir)` | Categorize phase events |
| `getCostFromEvents(dir)` | Extract final cost |
| `createTestCoordDir(name)` | Create test directory |
| `cleanupOldTestDirs()` | Remove dirs >7 days old |
| `TestRunner` | Simple test runner class |
| `assert`, `assertEqual`, `assertExists` | Assertion helpers |

### Mock Workers (`helpers/mock-worker.ts`)

| Export | Description |
|--------|-------------|
| `MockWorker` | Simulates worker lifecycle (start, tool calls, exit) |
| `createSuccessfulWorker(taskId)` | Worker that completes successfully |
| `createFailingWorker(taskId)` | Worker that fails with error |
| `createTimingOutWorker(taskId)` | Worker that times out |
| `createRestartingWorker(taskId)` | Worker that requests restart (exit 42) |

### Mock LLM (`helpers/mock-llm.ts`)

| Export | Description |
|--------|-------------|
| `MockLLM` | Provides deterministic LLM responses |
| `createInterviewMockLLM()` | LLM for interview question generation |
| `createScoutMockLLM()` | LLM for scout phase responses |
| `createElaborateMockLLM()` | LLM for elaborate phase responses |
| `createStructureMockLLM()` | LLM for structure phase (TASK-XX spec) |
| `createPassingReviewerMockLLM()` | Reviewer that finds no issues |
| `createFailingReviewerMockLLM()` | Reviewer that finds issues |

### Observability Assertions (`helpers/observability-assertions.ts`)

| Function | Description |
|----------|-------------|
| `readTypedEvents(dir)` | Read events with proper typing |
| `readSpans(dir)` | Read span data |
| `readDecisions(dir)` | Read coordinator decisions |
| `assertEventSequence(events, types)` | Verify event order |
| `assertEventExists(events, type, props)` | Verify event exists |
| `assertSpanHierarchy(spans, hierarchy)` | Verify span parent/child |
| `assertDecisionLogged(decisions, type)` | Verify decision was logged |
| `assertNoResourceLeaks(resources)` | Verify all resources released |
| `assertCausalLink(links, cause, effect)` | Verify causal relationship |
