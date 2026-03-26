import * as path from "node:path";
import * as fsSync from "node:fs";
import { randomUUID } from "node:crypto";
import { runAgentSDK } from "../../subagent/sdk-runner.js";
import { registerControls, unregisterControls, getAbort } from "../worker-control-registry.js";
import { discoverAgents } from "../../subagent/agents.js";
import { createContextUpdater, type ContextUpdater } from "../worker-context.js";
import { createArtifactPaths } from "../../subagent/artifacts.js";
import { consumeNudgeSync } from "../nudge.js";
import { loadRuntimeConfig, type WorkerConfig } from "./index.js";
import type { FileBasedStorage } from "../state.js";
import type { WorkerStateFile } from "../types.js";

export interface SDKWorkerHandle {
	workerId: string;
	identity: string;
	promise: Promise<number>; // resolves to exit code
	abort: () => void;
	contextUpdater?: ContextUpdater;
}

/** Context passed to the inline worker extension via closure */
export interface WorkerContext {
	coordDir: string;
	workerId: string;
	identity: string;
}

/**
 * Semantic match for "no issues found" responses from self-review.
 * Accepts natural language variations so the review loop doesn't get stuck
 * when the reviewer paraphrases the pass signal instead of using the exact phrase.
 */
function isNoIssuesResponse(text: string): boolean {
	const noIssuePatterns = [
		/no\s+(issues?|problems?|bugs?|concerns?|errors?)\s+(found|detected|identified|discovered|to\s+report|to\s+fix)/i,
		/found\s+no\s+(issues?|problems?|bugs?|concerns?)/i,
		/everything\s+(looks?|appears?|seems?)\s+(good|correct|fine|clean)/i,
		/all\s+(looks?|appears?|seems?)\s+(good|correct|fine|clean)/i,
		/code\s+(is|looks)\s+(clean|correct|good)/i,
		/nothing\s+to\s+(fix|report|change)/i,
		/lgtm/i,
		/implementation\s+(is|looks)\s+(correct|complete|solid)/i,
		/changes?\s+(look|are)\s+(good|correct|clean)/i,
		/meets?\s+(the|all)\s+(acceptance|criteria|requirements)/i,
		/verified.*(?:works?|correct|passing)/i,
	];
	return noIssuePatterns.some(p => p.test(text));
}

/**
 * Read the worker state file to get tracked filesModified.
 * Falls back to empty array on any error.
 */
function readWorkerFilesModified(coordDir: string, workerId: string): string[] {
	try {
		const statePath = path.join(coordDir, `worker-${workerId}.json`);
		const raw = fsSync.readFileSync(statePath, "utf-8");
		const state = JSON.parse(raw);
		return Array.isArray(state.filesModified) ? state.filesModified : [];
	} catch {
		return [];
	}
}

/**
 * Detect if the worker ran verification commands (tests, build, lint).
 * Scans the last N assistant messages for verification signals.
 */
function detectVerificationRan(messages: unknown[]): boolean {
	const verifyPatterns = [
		/tests?\s+(pass|passing|passed|succeed|green)/i,
		/build\s+(succeed|success|passed|complete)/i,
		/lint.*pass/i,
		/\b(npm|pnpm|yarn|bun)\s+(test|run\s+test)/i,
		/vitest|jest|mocha|pytest|cargo\s+test/i,
		/tsc\s+--noEmit/i,
		/✅.*test/i,
	];
	// Check last 5 messages for verification signals
	const recent = messages.slice(-5);
	for (const msg of recent) {
		const text = extractTextGlobal(msg);
		if (verifyPatterns.some(p => p.test(text))) return true;
	}
	return false;
}

/** Extract text from any message (used by detectVerificationRan) */
function extractTextGlobal(message: unknown): string {
	const msg = message as { role?: string; content?: Array<{ type: string; text?: string }> | string };
	if (!msg) return "";
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((block) => block.type === "text")
		.map((block) => block.text || "")
		.join("\n");
}

/**
 * Adaptive cycle count — adjusts based on what actually happened.
 * No files modified → 0 (auto-pass)
 * Files modified + tests passed → 1 (quick sanity)
 * Files modified, no tests, single file → 1
 * Files modified, no tests, multi-file → 2
 */
function getAdaptiveMaxCycles(filesModified: string[], verificationRan: boolean, configMax: number): number {
	if (!filesModified.length) return 0;
	if (verificationRan) return Math.min(1, configMax);
	if (filesModified.length > 3) return Math.min(2, configMax);
	return Math.min(1, configMax);
}

/**
 * Spec-aware review prompt — references actual files and acceptance criteria
 * instead of generic "look for bugs".
 */
function getAdaptiveReviewPrompt(filesModified: string[], specPath?: string): string {
	const fileList = filesModified.length > 0
		? `\nFiles you modified:\n${filesModified.map(f => "- " + f).join("\n")}\n`
		: "";
	const specRef = specPath
		? `\nRe-read the acceptance criteria in the spec: ${specPath}\n`
		: "";

	return `Do a focused review of your changes.${fileList}${specRef}
Check specifically:
1. Does your implementation match the acceptance criteria for this task?
2. Any obvious bugs or logic errors in the code you changed?
3. Missing error handling for the happy path?

If your changes meet the acceptance criteria and have no obvious issues, respond with: "No issues found."
If you find issues, fix them and then call agent_work({ action: 'complete' }) again.`;
}

/**
 * Create an inline extension factory that captures worker context in a closure.
 * This avoids the race condition with process.env when multiple workers spawn concurrently.
 */
function createWorkerExtensionFactory(ctx: WorkerContext) {
	return async (pi: import("@mariozechner/pi-coding-agent").ExtensionAPI): Promise<void> => {
		const { coordDir, workerId, identity } = ctx;

		// Import and register worker tools with explicit context (avoids env var race)
		const { registerWorkerTools } = await import("../../coordinate/worker-tools/index.js");
		const { A2AManager } = await import("../../coordinate/a2a.js");

		// Pass context directly to avoid race condition with env vars
		registerWorkerTools(pi, { coordDir, workerId, identity });

		const maxSelfReviewCycles = parseInt(process.env.PI_MAX_SELF_REVIEW_CYCLES || "5");
		const selfReviewEnabled = process.env.PI_SELF_REVIEW_ENABLED !== "false";
		const specPath = process.env.PI_SELF_REVIEW_SPEC_PATH;

		interface SelfReviewState {
			count: number;
			passed: boolean;
			pendingCompletion: { result: string; filesModified?: string[] } | null;
		}

		const selfReview: SelfReviewState = {
			count: 0,
			passed: false,
			pendingCompletion: null,
		};

		const a2a = new A2AManager(coordDir);
		let lastA2ACheck = Date.now();

		function extractTextFromMessage(message: unknown): string {
			const msg = message as { role?: string; content?: Array<{ type: string; text?: string }> };
			if (!msg || msg.role !== "assistant") return "";
			if (!Array.isArray(msg.content)) return "";
			return msg.content
				.filter((block) => block.type === "text")
				.map((block) => block.text || "")
				.join("\n");
		}

		// getSelfReviewPrompt replaced by getAdaptiveReviewPrompt (module-level function)

		function emitEvent(type: string, data: Record<string, unknown>): void {
			try {
				const eventLine = JSON.stringify({
					type,
					workerId,
					identity,
					timestamp: Date.now(),
					...data,
				});
				fsSync.appendFileSync(path.join(coordDir, "events.jsonl"), eventLine + "\n");
			} catch {}
		}

		// Tool call handler for adaptive self-review blocking
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "agent_work") return;
			if (event.input.action !== "complete") return;
			if (!selfReviewEnabled) return;
			if (selfReview.passed) return;

			const result = typeof event.input.result === "string" ? event.input.result : "Task finished";
			const explicitFiles = Array.isArray(event.input.filesModified)
				? (event.input.filesModified as string[])
				: undefined;

			// Read tracked filesModified from worker state (more reliable than explicit param)
			const trackedFiles = readWorkerFilesModified(coordDir, workerId);
			const filesModified = explicitFiles?.length ? explicitFiles : trackedFiles;

			// ADAPTIVE: Auto-pass if no files were modified (read-only/verification tasks)
			if (!filesModified.length) {
				selfReview.passed = true;
				emitEvent("self_review_skipped", { reason: "no_files_modified" });
				return; // Don't block — let completion through immediately
			}

			selfReview.pendingCompletion = { result, filesModified };

			return {
				block: true,
				reason: "Self-review required before completion. Initiating review...",
			};
		});

		// Agent end handler for adaptive self-review continuation
		pi.on("agent_end", async (event) => {
			if (!selfReviewEnabled) return;
			if (!selfReview.pendingCompletion) return;

			const messages = (event as { messages?: unknown[] }).messages;
			if (!messages || messages.length === 0) return;

			const lastMessage = messages[messages.length - 1];
			const text = extractTextFromMessage(lastMessage);

			if (isNoIssuesResponse(text)) {
				selfReview.passed = true;
				emitEvent("self_review_passed", { cycleNumber: selfReview.count });
				selfReview.count = 0;

				pi.sendMessage(
					{
						customType: "self-review-complete",
						content: `Self-review passed. Now call agent_work({ action: 'complete', result: '${selfReview.pendingCompletion.result.replace(/'/g, "\\'")}' })`,
						display: true,
					},
					{ triggerTurn: true },
				);
				return;
			}

			// ADAPTIVE: Calculate max cycles based on what actually happened
			const filesModified = selfReview.pendingCompletion.filesModified || [];
			const verificationRan = detectVerificationRan(messages);
			const adaptiveMax = getAdaptiveMaxCycles(filesModified, verificationRan, maxSelfReviewCycles);

			if (selfReview.count >= adaptiveMax) {
				selfReview.passed = true;
				emitEvent("self_review_limit_reached", {
					maxCycles: adaptiveMax,
					configMax: maxSelfReviewCycles,
					filesModified: filesModified.length,
					verificationRan,
					reason: adaptiveMax < maxSelfReviewCycles ? "adaptive_reduction" : "config_limit",
				});

				pi.sendMessage(
					{
						customType: "self-review-limit",
						content: `Self-review complete (${selfReview.count}/${adaptiveMax} cycles). Proceeding. Call agent_work({ action: 'complete', result: '${selfReview.pendingCompletion.result.replace(/'/g, "\\'")}' }) now.`,
						display: true,
					},
					{ triggerTurn: true },
				);
				return;
			}

			selfReview.count++;
			emitEvent("self_review_started", {
				cycleNumber: selfReview.count,
				adaptiveMax,
				filesModified: filesModified.length,
			});

			pi.sendMessage(
				{
					customType: "self-review",
					content: getAdaptiveReviewPrompt(filesModified, specPath),
					display: true,
				},
				{ triggerTurn: true },
			);
		});

		// Turn start handler for nudges and A2A messages
		// Note: For SDK workers, nudge handling for restart/abort is done externally
		// via session.steer() and session.abort() - we only handle wrap_up here
		pi.on("turn_start", async () => {
			const nudges = consumeNudgeSync(coordDir, workerId);
			for (const nudge of nudges) {
				emitEvent("worker_nudged", { nudgeType: nudge.type });

				if (nudge.type === "wrap_up") {
					pi.sendMessage(
						{
							customType: "nudge",
							content: `[Supervisor] ${nudge.message}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				} else if (nudge.type === "abort") {
					// Signal abort via the control registry
					emitEvent("worker_abort_nudge", { message: nudge.message });
					const abortFn = getAbort(workerId);
					if (abortFn) abortFn();
				}
			}

			const now = Date.now();
			if (now - lastA2ACheck > 5000) {
				lastA2ACheck = now;
				await checkA2AMessages();
			}
		});

		async function checkA2AMessages(): Promise<void> {
			try {
				const messages = a2a.checkMessagesSync(identity);
				const handledIds: string[] = [];

				for (const msg of messages) {
					if (msg.from === identity) continue;

					switch (msg.payload.type) {
						case "file_release_request":
							pi.sendMessage(
								{
									customType: "a2a-request",
									content: `[${msg.from}] requests file "${msg.payload.file}": ${msg.payload.reason} (urgency: ${msg.payload.urgency})`,
									display: true,
								},
								{ triggerTurn: false },
							);
							handledIds.push(msg.id);
							break;

						case "discovery":
							if (msg.payload.importance !== "fyi") {
								pi.sendMessage(
									{
										customType: "a2a-discovery",
										content: `[${msg.from}] shared [${msg.payload.importance.toUpperCase()}]: ${msg.payload.topic}\n${msg.payload.content}`,
										display: true,
									},
									{ triggerTurn: false },
								);
							}
							handledIds.push(msg.id);
							break;

						case "completion_notice":
							handledIds.push(msg.id);
							break;

						default:
							handledIds.push(msg.id);
					}
				}

				if (handledIds.length > 0) {
					await a2a.markRead(handledIds);
				}
			} catch {}
		}
	};
}

/**
 * Spawn a worker using SDK-based in-process execution.
 * Returns synchronously (like subprocess version), starts async work in background.
 *
 * This implementation uses inline extension factories to pass worker context,
 * avoiding the race condition with process.env when multiple workers spawn concurrently.
 */
export function spawnWorkerSDK(
	config: WorkerConfig,
	coordDir: string,
	cwd: string,
	storage: FileBasedStorage,
	modelOverride?: string,
	taskId?: string,
): SDKWorkerHandle {
	const { workerId, identity } = config;
	const shortId = workerId.slice(0, 4);
	const sessionAbortController = new AbortController();

	// Discover agent (synchronous, like subprocess version)
	const { agents } = discoverAgents(cwd, "user");
	const workerAgent = agents.find((a) => a.name === "coordination/worker") || agents.find((a) => a.name === "worker");

	// Resolve model - fall back to undefined if no agent found (SDK will use default)
	const runtimeConfig = loadRuntimeConfig(coordDir);
	const model = modelOverride || runtimeConfig.models?.worker || workerAgent?.model;

	// Create a minimal agent config if none found
	const agentConfig = workerAgent ?? {
		name: "worker",
		description: "Coordination worker",
		systemPrompt: "",
		source: "user" as const,
		filePath: "",
		model,
	};

	// Create artifacts
	const runId = randomUUID();
	const artifactPaths = createArtifactPaths(identity, runId, path.join(coordDir, "artifacts"));

	// Create initial worker state file (synchronous, like subprocess version)
	const initialState: WorkerStateFile = {
		id: workerId,
		shortId,
		identity,
		agent: config.agent,
		status: "working",
		currentFile: null,
		currentTool: null,
		waitingFor: null,
		assignedSteps: config.steps,
		completedSteps: [],
		currentStep: config.steps[0] || null,
		handshakeSpec: config.handshakeSpec,
		startedAt: Date.now(),
		completedAt: null,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		recentTools: [],
		lastOutput: "",
		artifactsDir: artifactPaths.dir,
		filesModified: [],
		blockers: [],
		errorType: null,
		errorMessage: null,
	};

	// Write initial state synchronously (like subprocess version)
	fsSync.writeFileSync(path.join(coordDir, `worker-${workerId}.json`), JSON.stringify(initialState, null, 2));

	// Create context updater for smart restarts
	const contextUpdater = taskId ? createContextUpdater(coordDir, taskId, workerId, identity) : undefined;

	// Create worker context for the inline extension
	const workerContext: WorkerContext = { coordDir, workerId, identity };

	// Track lastOutput for change detection (worker_output event emission)
	let prevLastOutput = "";

	// Start async execution (non-blocking)
	const promise = (async () => {
		// Register abort function immediately (before session starts)
		registerControls(workerId, {
			abort: () => sessionAbortController.abort(),
		});

		try {
			const result = await runAgentSDK({
				cwd,
				agent: { ...agentConfig, model },
				task: config.handshakeSpec,
				signal: sessionAbortController.signal,
				// Use inline extension factory instead of file path - captures context in closure
				inlineExtensions: [createWorkerExtensionFactory(workerContext)],
				artifactsDir: path.join(coordDir, "artifacts"),
				artifactLabel: identity,
				onSessionReady: (steer) => {
					registerControls(workerId, { steer });
				},
				onProgress: (progress) => {
					// Update worker state file with progress
					storage
						.updateWorkerState(workerId, (s) => ({
							...s,
							toolCount: progress.toolCount,
							tokens: progress.tokens,
							durationMs: progress.durationMs,
							currentTool: progress.currentTool || null,
							recentTools: progress.recentTools,
							lastOutput: progress.lastOutput || s.lastOutput,
							usage: progress.usage,
						}))
						.catch(() => {});

					// Emit worker_output event when lastOutput changes
					if (progress.lastOutput && progress.lastOutput !== prevLastOutput) {
						try {
							const preview = progress.lastOutput
								.split('\n')
								.filter((l: string) => l.trim())
								.slice(-1)[0]
								?.slice(0, 120) || "";
							const eventLine = JSON.stringify({
								type: "worker_output",
								workerId,
								workerName: identity,
								preview,
								timestamp: Date.now(),
							});
							fsSync.appendFileSync(path.join(coordDir, "events.jsonl"), eventLine + "\n");
						} catch {}
						prevLastOutput = progress.lastOutput;
					}
				},
			});

			// Update final state
			await storage.updateWorkerState(workerId, (s) => ({
				...s,
				status: result.exitCode === 0 ? "complete" : "failed",
				completedAt: Date.now(),
				errorMessage: result.errorMessage || null,
			}));

			// Track in context updater
			contextUpdater?.onWorkerEnd(result.exitCode);

			return result.exitCode;
		} catch (err) {
			// Update state to failed on exception
			await storage.updateWorkerState(workerId, (s) => ({
				...s,
				status: "failed",
				completedAt: Date.now(),
				errorMessage: err instanceof Error ? err.message : String(err),
			})).catch(() => {});

			contextUpdater?.onWorkerEnd(1);

			return 1;
		} finally {
			// Always unregister all controls
			unregisterControls(workerId);
		}
	})();

	return {
		workerId,
		identity,
		promise,
		abort: () => sessionAbortController.abort(),
		contextUpdater,
	};
}
