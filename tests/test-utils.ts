/**
 * Test utilities for coordination integration tests
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execution info for coordinate tool (two-track architecture)
 */
export interface ExecutionInfo {
	mode: "spec";
	skipScout: boolean;
	skipPlanner: boolean;
	taskCount: number;
	timestamp: number;
}

export interface CoordinationEvent {
	type: string;
	phase?: string;
	workerId?: string;
	timestamp: number;
	[key: string]: unknown;
}

export interface ValidationResult {
	hardFailures: Array<{ invariant: string; message: string }>;
	softFailures: Array<{ invariant: string; message: string }>;
	warnings: Array<{ invariant: string; message: string }>;
}

export interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
	duration: number;
	coordDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Observability readers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read execution info from coordinate tool (two-track architecture)
 */
export function readExecutionInfo(coordDir: string): ExecutionInfo | null {
	const filePath = path.join(coordDir, "execution-info.json");
	if (!fs.existsSync(filePath)) return null;
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function readEvents(coordDir: string): CoordinationEvent[] {
	const filePath = path.join(coordDir, "events.jsonl");
	if (!fs.existsSync(filePath)) return [];
	
	const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
	const events: CoordinationEvent[] = [];
	
	for (const line of lines) {
		try {
			events.push(JSON.parse(line));
		} catch {
			// Skip malformed lines
		}
	}
	
	return events;
}

export function readErrors(coordDir: string): Array<{ category: string; message: string; severity: string }> {
	const filePath = path.join(coordDir, "errors.jsonl");
	if (!fs.existsSync(filePath)) return [];
	
	const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
	const errors: Array<{ category: string; message: string; severity: string }> = [];
	
	for (const line of lines) {
		try {
			errors.push(JSON.parse(line));
		} catch {
			// Skip malformed lines
		}
	}
	
	return errors;
}

export function getPhaseEvents(coordDir: string): { started: string[]; completed: string[]; skipped: string[] } {
	const events = readEvents(coordDir);
	
	const started: string[] = [];
	const completed: string[] = [];
	const skipped: string[] = [];
	
	for (const event of events) {
		if (event.type === "phase_started" && event.phase) {
			started.push(event.phase);
		} else if (event.type === "phase_completed" && event.phase) {
			completed.push(event.phase);
		} else if (event.type === "phase_skipped" && event.phase) {
			skipped.push(event.phase);
		}
	}
	
	return { started, completed, skipped };
}

export function getCostFromEvents(coordDir: string): number {
	const events = readEvents(coordDir);
	
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === "cost_updated" && typeof events[i].total === "number") {
			return events[i].total as number;
		}
	}
	
	return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stdin mocking for TUI tests
// ─────────────────────────────────────────────────────────────────────────────

export interface MockStdinOptions {
	/** Sequence of keys to send */
	keys: string[];
	/** Delay between keys in ms */
	delayMs?: number;
}

/**
 * Create a mock stdin that sends predefined key sequences
 */
export function createMockStdin(options: MockStdinOptions): NodeJS.ReadStream {
	const { keys, delayMs = 50 } = options;
	const emitter = new EventEmitter();
	let keyIndex = 0;
	let interval: NodeJS.Timeout | null = null;
	
	const mockStdin = {
		isTTY: true,
		isRaw: false,
		setRawMode(mode: boolean) {
			(mockStdin as any).isRaw = mode;
			return mockStdin;
		},
		resume() {
			// Start sending keys after a short delay
			if (interval) return;
			interval = setInterval(() => {
				if (keyIndex < keys.length) {
					const key = keys[keyIndex++];
					emitter.emit("data", Buffer.from(key));
				} else {
					if (interval) {
						clearInterval(interval);
						interval = null;
					}
				}
			}, delayMs);
		},
		pause() {
			if (interval) {
				clearInterval(interval);
				interval = null;
			}
		},
		on(event: string, handler: (...args: any[]) => void) {
			emitter.on(event, handler);
			return mockStdin;
		},
		removeListener(event: string, handler: (...args: any[]) => void) {
			emitter.removeListener(event, handler);
			return mockStdin;
		},
		// Minimal stream interface
		readable: true,
		read() { return null; },
		destroy() { this.pause(); },
	};
	
	return mockStdin as unknown as NodeJS.ReadStream;
}

/** Key constants for mock stdin */
export const Keys = {
	ENTER: "\r",
	ESC: "\x1b",
	UP: "\x1b[A",
	DOWN: "\x1b[B",
	TAB: "\t",
	BACKSPACE: "\x7f",
};

// ─────────────────────────────────────────────────────────────────────────────
// Test directory management
// ─────────────────────────────────────────────────────────────────────────────

const TEST_OUTPUT_DIR = path.join(process.cwd(), "tests", "output");
const CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function getTestOutputDir(): string {
	if (!fs.existsSync(TEST_OUTPUT_DIR)) {
		fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
	}
	return TEST_OUTPUT_DIR;
}

export function createTestCoordDir(testName: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dirName = `${testName}-${timestamp}`;
	const coordDir = path.join(getTestOutputDir(), dirName);
	fs.mkdirSync(coordDir, { recursive: true });
	return coordDir;
}

/**
 * Clean up test output directories older than 7 days
 */
export function cleanupOldTestDirs(): { deleted: string[]; kept: string[] } {
	const deleted: string[] = [];
	const kept: string[] = [];
	
	if (!fs.existsSync(TEST_OUTPUT_DIR)) {
		return { deleted, kept };
	}
	
	const now = Date.now();
	const entries = fs.readdirSync(TEST_OUTPUT_DIR, { withFileTypes: true });
	
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		
		const dirPath = path.join(TEST_OUTPUT_DIR, entry.name);
		const stat = fs.statSync(dirPath);
		const age = now - stat.mtimeMs;
		
		if (age > CLEANUP_AGE_MS) {
			fs.rmSync(dirPath, { recursive: true, force: true });
			deleted.push(entry.name);
		} else {
			kept.push(entry.name);
		}
	}
	
	return { deleted, kept };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test runner utilities
// ─────────────────────────────────────────────────────────────────────────────

export class TestRunner {
	private results: TestResult[] = [];
	private currentSection = "";
	
	section(name: string) {
		this.currentSection = name;
		console.log(`\n${"═".repeat(60)}`);
		console.log(`  ${name}`);
		console.log(`${"═".repeat(60)}`);
	}
	
	async test(name: string, fn: () => Promise<{ coordDir?: string }> | { coordDir?: string } | void) {
		const start = Date.now();
		const fullName = this.currentSection ? `${this.currentSection} > ${name}` : name;
		
		try {
			const result = await fn();
			const duration = Date.now() - start;
			
			console.log(`  ✓ ${name} (${duration}ms)`);
			this.results.push({
				name: fullName,
				passed: true,
				duration,
				coordDir: result?.coordDir,
			});
		} catch (err) {
			const duration = Date.now() - start;
			const error = err instanceof Error ? err.message : String(err);
			
			console.log(`  ✗ ${name} (${duration}ms)`);
			console.log(`    Error: ${error}`);
			this.results.push({
				name: fullName,
				passed: false,
				error,
				duration,
			});
		}
	}
	
	summary() {
		const passed = this.results.filter(r => r.passed).length;
		const failed = this.results.filter(r => !r.passed).length;
		const total = this.results.length;
		const totalTime = this.results.reduce((sum, r) => sum + r.duration, 0);
		
		console.log(`\n${"═".repeat(60)}`);
		console.log(`  SUMMARY`);
		console.log(`${"═".repeat(60)}`);
		console.log(`  Passed: ${passed}/${total}`);
		console.log(`  Failed: ${failed}/${total}`);
		console.log(`  Time: ${(totalTime / 1000).toFixed(1)}s`);
		
		if (failed > 0) {
			console.log(`\n  Failed tests:`);
			for (const r of this.results.filter(r => !r.passed)) {
				console.log(`    - ${r.name}`);
				if (r.error) console.log(`      ${r.error}`);
			}
		}
		
		// List coord dirs for debugging
		const dirs = this.results.filter(r => r.coordDir).map(r => r.coordDir);
		if (dirs.length > 0) {
			console.log(`\n  Coordination dirs (for debugging):`);
			for (const dir of dirs) {
				console.log(`    ${dir}`);
			}
		}
		
		console.log("");
		return { passed, failed, total };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertions
// ─────────────────────────────────────────────────────────────────────────────

export function assert(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
	if (actual !== expected) {
		throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

export function assertDeepEqual<T>(actual: T, expected: T, message?: string): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

export function assertContains(array: unknown[], item: unknown, message?: string): void {
	if (!array.includes(item)) {
		throw new Error(message || `Expected array to contain ${JSON.stringify(item)}`);
	}
}

export function assertNotContains(array: unknown[], item: unknown, message?: string): void {
	if (array.includes(item)) {
		throw new Error(message || `Expected array NOT to contain ${JSON.stringify(item)}`);
	}
}

export function assertExists(value: unknown, message?: string): asserts value {
	if (value === null || value === undefined) {
		throw new Error(message || `Expected value to exist`);
	}
}
