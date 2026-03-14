/**
 * auto-repair.ts — Heuristics for detecting test failures and triggering repairs.
 *
 * The test-result regex is deliberately specific: it anchors to the beginning
 * of a line OR to a known test-runner prefix so that inline strings in agent
 * output don't produce false positives.
 */

// Known test-runner output prefixes (Jest, Vitest, Mocha, tap, node:test).
// The regex matches at the very start of a line (^) to avoid spurious matches
// inside prose or code samples that happen to contain runner keywords.
const RUNNER_LINE_RE =
	/^(?:PASS|FAIL|Tests:|Test Suites:|Suites:|✓|✗|×|●|○|passing|failing|not ok|ok)\b/im;

/**
 * More specific pattern (M-8 fix): matches at the beginning of a line OR
 * immediately after a known runner prefix, not just anywhere in the output.
 *
 * Captures:
 *  - Jest/Vitest summary:   "Tests: 3 failed, 12 passed"
 *  - Jest/Vitest suite:     "PASS src/foo.test.ts" / "FAIL src/bar.test.ts"
 *  - Mocha:                 "3 failing" / "12 passing"
 *  - tap / node:test:       "not ok 1 – some test"
 */
export const TEST_RESULT_REGEX =
	/^(?:(?:PASS|FAIL)\s+\S.*|Tests:\s*(?:\d+\s+\w+(?:,\s*)?)+|(?:Test\s+Suites?|Suites?):\s*\d+.*|\d+\s+(?:passing|failing)(?:\s+\(\d+\w+\))?|not\s+ok\s+\d+)/im;

export interface RepairCandidate {
	/** Raw line(s) of test output that triggered this candidate */
	rawOutput: string;
	/** Number of detected failures (best-effort parse) */
	failureCount: number;
	/** Whether the output looks like a definitive failure (not a flaky/warning) */
	definitive: boolean;
}

/**
 * Scan `output` for test failure indicators using the anchored regex.
 *
 * Only lines that start with (or follow immediately after) a recognised
 * test-runner prefix are considered.  This prevents prose in agent responses
 * from triggering false auto-repair cycles.
 */
export function detectTestFailures(output: string): RepairCandidate[] {
	const candidates: RepairCandidate[] = [];

	for (const line of output.split("\n")) {
		// Guard: only proceed if the line matches the anchored runner pattern.
		if (!RUNNER_LINE_RE.test(line) && !TEST_RESULT_REGEX.test(line)) {
			continue;
		}

		// Try to extract a failure count.
		const failMatch = line.match(/(\d+)\s+fail(?:ed|ing)/i);
		const notOkMatch = line.match(/^not\s+ok\s+(\d+)/i);
		const suiteFailMatch = line.match(/(\d+)\s+(?:test\s+suite(?:s)?|suite(?:s)?)\s+fail(?:ed)?/i);

		const failureCount = failMatch
			? parseInt(failMatch[1], 10)
			: notOkMatch
			? 1
			: suiteFailMatch
			? parseInt(suiteFailMatch[1], 10)
			: 0;

		if (failureCount > 0 || /^FAIL\b/i.test(line) || /^not\s+ok\b/i.test(line)) {
			candidates.push({
				rawOutput: line.trim(),
				failureCount,
				// "FAIL src/..." and "not ok N" are definitive; "X failing" can be flaky
				definitive: /^(?:FAIL\b|not\s+ok\b)/i.test(line),
			});
		}
	}

	return candidates;
}

/**
 * Returns `true` if `output` contains any definitive test failures that
 * warrant an auto-repair attempt.
 */
export function shouldAutoRepair(output: string): boolean {
	return detectTestFailures(output).some((c) => c.definitive || c.failureCount > 0);
}
