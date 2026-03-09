/**
 * SDK-based agent runner using Pi's createAgentSession() API.
 *
 * Replaces subprocess spawning with in-process agent execution for:
 * - Lower startup overhead (~50ms vs ~500ms)
 * - Direct event subscription (no JSON stdout parsing)
 * - Agent-scoped extensions, skills, and context files
 * - Output validation hooks with retry capability
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import { classifyProviderFailure, inferProviderFromModel, recordProviderOutcome, resolveParentModelHint, selectModelCandidate } from "./provider-health.js";
import { createArtifactPaths } from "./artifacts.js";
import { truncateOutputHead } from "./truncate.js";
import type { OnUpdateCallback, OutputLimits, SingleResult, SubagentDetails } from "./types.js";

// SDK imports - these will be available when pi-coding-agent is installed
// Types are imported separately to avoid runtime errors when SDK is not available
type CreateAgentSessionFn = typeof import("@mariozechner/pi-coding-agent").createAgentSession;
type SessionManagerType = typeof import("@mariozechner/pi-coding-agent").SessionManager;
type ToolDefinitionType = import("@mariozechner/pi-coding-agent").ToolDefinition;

let createAgentSession: CreateAgentSessionFn | null = null;
let SessionManager: SessionManagerType | null = null;
let sdkAvailable = false;

// Dynamic import to handle cases where SDK might not be available
async function ensureSDK(): Promise<boolean> {
	if (sdkAvailable) return true;
	try {
		const sdk = await import("@mariozechner/pi-coding-agent");
		createAgentSession = sdk.createAgentSession;
		SessionManager = sdk.SessionManager;
		sdkAvailable = true;
		return true;
	} catch (err) {
		console.warn("[sdk-runner] Pi SDK not available, falling back to subprocess:", err);
		return false;
	}
}

const UPDATE_THROTTLE_MS = 250;
const MAX_RECENT_TOOLS = 5;

function extractToolArgsPreview(args: Record<string, unknown>): string | null {
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];
	for (const key of previewKeys) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			return value.length > 60 ? `${value.slice(0, 57)}...` : value;
		}
	}
	return null;
}

/** Progress data emitted during execution */
export interface SDKProgress {
	toolCount: number;
	tokens: number;
	durationMs: number;
	currentTool?: string;
	currentToolArgs?: string;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	lastOutput?: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
}

/** Extension factory type for inline extensions */
type ExtensionFactoryType = (pi: import("@mariozechner/pi-coding-agent").ExtensionAPI) => void | Promise<void>;

export interface SDKRunnerConfig {
	/** Working directory for the agent */
	cwd: string;
	/** Agent configuration from frontmatter */
	agent: AgentConfig;
	/** Task prompt to send to the agent */
	task: string;
	/** Abort signal for cancellation */
	signal?: AbortSignal;
	/** Callback for progress updates */
	onUpdate?: OnUpdateCallback;
	/** Function to build details for progress updates */
	makeDetails?: (results: SingleResult[]) => SubagentDetails;
	/** Output limits for truncation */
	outputLimits?: OutputLimits;
	/** Directory for artifacts (input, output, jsonl files) */
	artifactsDir?: string;
	/** Label for artifact files */
	artifactLabel?: string;
	/** Step number (for display) */
	step?: number;
	/** Additional extension paths to load */
	extensions?: string[];
	/** Parent runtime model hint propagated to subagents */
	parentModel?: string;
	/** Inline extension factories (passed directly, no file loading) */
	inlineExtensions?: ExtensionFactoryType[];
	/** Custom tools to register (for coordinator) */
	customTools?: ToolDefinitionType[];
	/** Called when session is ready, providing the steer function. */
	onSessionReady?: (steer: (message: string) => Promise<void>) => void;
	/** Called when session is ready, providing the session abort function.
	 *  Note: This aborts the entire session, not just the current tool. */
	onInterruptReady?: (abort: () => Promise<void>) => void;
	/** Called on progress updates (tool events, messages). */
	onProgress?: (progress: SDKProgress) => void;
}

/**
 * Run an agent using the Pi SDK's createAgentSession() API.
 *
 * This function:
 * 1. Creates an in-memory session (no file persistence)
 * 2. Configures the agent with model, tools, and system prompt
 * 3. Subscribes to events for progress tracking and usage collection
 * 4. Sends the task prompt and waits for completion
 * 5. Returns a SingleResult matching the subprocess runner's interface
 */
export async function runAgentSDK(config: SDKRunnerConfig): Promise<SingleResult> {
	const {
		cwd,
		agent,
		task,
		signal,
		onUpdate,
		makeDetails,
		outputLimits,
		artifactsDir,
		artifactLabel,
		step,
		extensions,
		parentModel,
		inlineExtensions,
		customTools,
		onSessionReady,
		onInterruptReady,
		onProgress,
	} = config;

	// Ensure SDK is available
	if (!(await ensureSDK()) || !createAgentSession || !SessionManager) {
		return {
			agent: agent.name,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: "Pi SDK not available",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const startTime = Date.now();
	const runId = randomUUID();
	const resolvedParentModel = resolveParentModelHint(parentModel, process.env.PI_MODEL);
	const providerSelection = selectModelCandidate(agent.model, resolvedParentModel);
	const artifactPaths = createArtifactPaths(artifactLabel ?? agent.name, runId, artifactsDir);

	// Initialize result tracking
	const currentResult: SingleResult = {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: providerSelection.selectedModel || agent.model || resolvedParentModel,
		providerSelection,
		step,
		artifactPaths,
		toolCount: 0,
		recentTools: [],
	};

	let lastUpdateMs = 0;
	const emitUpdate = (force = false) => {
		if (onUpdate && makeDetails) {
			const now = Date.now();
			if (!force && now - lastUpdateMs < UPDATE_THROTTLE_MS) return;
			lastUpdateMs = now;
			currentResult.durationMs = now - startTime;
			currentResult.tokens =
				currentResult.usage.input +
				currentResult.usage.output +
				currentResult.usage.cacheRead +
				currentResult.usage.cacheWrite;
			onUpdate({
				content: [{ type: "text", text: currentResult.output || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	// Write input artifact
	const systemPrompt = agent.systemPrompt.trim();
	const inputContent = systemPrompt ? `# System Prompt\n\n${systemPrompt}\n\n# Task\n\n${task}` : task;
	try {
		fs.writeFileSync(artifactPaths.inputPath, inputContent, { encoding: "utf-8", mode: 0o600 });
	} catch {}

	// Open JSONL stream for event logging
	const jsonlStream = fs.createWriteStream(artifactPaths.jsonlPath, { flags: "a" });

	let rawOutput = "";

	try {
		// Set agent identity for extensions to check
		const previousIdentity = process.env.PI_AGENT_IDENTITY;
		const previousModel = process.env.PI_MODEL;
		process.env.PI_AGENT_IDENTITY = agent.name;
		if (resolvedParentModel) process.env.PI_MODEL = resolvedParentModel;

		// Log agent configuration
		const hasTools = agent.tools && agent.tools.length > 0;
		const toolsList = hasTools
			? agent.tools!.join(", ")
			: agent.systemPromptMode === "override"
				? "NONE"
				: "default";
		const modeLabel = agent.systemPromptMode === "override" ? "override" : "append";
		console.log(`[sdk-runner] ${agent.name}: model=${providerSelection.selectedModel || agent.model || resolvedParentModel || "default"}, tools=[${toolsList}], prompt=${modeLabel}`);

		// Resolve tools - separate built-in from extension paths
		let builtinTools: string[] = [];
		const extensionPaths: string[] = [...(extensions ?? [])];

		if (agent.tools && agent.tools.length > 0) {
			for (const t of agent.tools) {
				if (t.includes("/") || t.endsWith(".ts") || t.endsWith(".js")) {
					extensionPaths.push(t);
				} else {
					builtinTools.push(t);
				}
			}
		}

		// Add agent's own extensions (resolved relative to agent file)
		if (agent.extensions) {
			const agentDir = path.dirname(agent.filePath);
			const agentExtensions = Array.isArray(agent.extensions) ? agent.extensions : [agent.extensions];
			for (const ext of agentExtensions) {
				const resolvedPath = path.isAbsolute(ext) ? ext : path.resolve(agentDir, ext);
				extensionPaths.push(resolvedPath);
			}
		}

		// Resolve skills and context files from agent config
		const skills = agent.skills ?? undefined; // undefined = discover, [] = skip
		const contextFiles = agent.contextFiles ?? undefined; // undefined = discover, [] = skip

		// Create session options
		const sessionOptions: Parameters<typeof createAgentSession>[0] = {
			cwd,
			sessionManager: SessionManager.inMemory(cwd),
			// Let SDK discover model if not specified
			...(providerSelection.selectedModel ? { model: await resolveModel(providerSelection.selectedModel) } : {}),
			// System prompt handling
			systemPrompt: systemPrompt
				? agent.systemPromptMode === "override"
					? systemPrompt
					: (defaultPrompt: string) => `${defaultPrompt}\n\n${systemPrompt}`
				: undefined,
			// Tool configuration - empty array means no discovery, but we need built-in tools
			...(builtinTools.length > 0 ? { tools: await resolveBuiltinTools(builtinTools, cwd) } : {}),
			// Extension paths (skip discovery if explicitly configured)
			...(extensionPaths.length > 0 ? { additionalExtensionPaths: extensionPaths } : {}),
			// Inline extension factories (passed directly, no file loading)
			...(inlineExtensions && inlineExtensions.length > 0 ? { extensions: inlineExtensions } : {}),
			// Skills configuration (undefined = discover, [] = skip)
			...(skills !== undefined ? { skills: skills } : {}),
			// Context files configuration (undefined = discover, [] = skip)
			...(contextFiles !== undefined ? { contextFiles: contextFiles } : {}),
			// Custom tools (for coordinator)
			...(customTools ? { customTools } : {}),
		};

		const { session } = await createAgentSession(sessionOptions);

		// Expose steer function for external steering
		if (onSessionReady) {
			onSessionReady(session.steer.bind(session));
		}

		// Expose abort function for terminating the session
		if (onInterruptReady) {
			onInterruptReady(session.abort.bind(session));
		}

		// Subscribe to events for progress tracking
		const unsubscribe = session.subscribe((event) => {
			// Log all events to JSONL
			try {
				jsonlStream.write(JSON.stringify(event) + "\n");
			} catch {}

			switch (event.type) {
				case "tool_execution_start":
					currentResult.toolCount = (currentResult.toolCount ?? 0) + 1;
					currentResult.currentTool = event.toolName;
					currentResult.currentToolArgs = extractToolArgsPreview(event.args || {}) || undefined;
					emitUpdate();
					onProgress?.({
						toolCount: currentResult.toolCount ?? 0,
						tokens: currentResult.tokens ?? 0,
						durationMs: Date.now() - startTime,
						currentTool: currentResult.currentTool,
						currentToolArgs: currentResult.currentToolArgs,
						recentTools: currentResult.recentTools ?? [],
						lastOutput: currentResult.output,
						usage: {
							input: currentResult.usage.input,
							output: currentResult.usage.output,
							cacheRead: currentResult.usage.cacheRead,
							cacheWrite: currentResult.usage.cacheWrite,
							cost: currentResult.usage.cost,
							turns: currentResult.usage.turns,
						},
					});
					break;

				case "tool_execution_end":
					if (currentResult.currentTool) {
						currentResult.recentTools?.unshift({
							tool: currentResult.currentTool,
							args: currentResult.currentToolArgs || "",
							endMs: Date.now(),
						});
						if ((currentResult.recentTools?.length || 0) > MAX_RECENT_TOOLS) {
							currentResult.recentTools = currentResult.recentTools?.slice(0, MAX_RECENT_TOOLS);
						}
					}
					currentResult.currentTool = undefined;
					currentResult.currentToolArgs = undefined;
					emitUpdate();
					onProgress?.({
						toolCount: currentResult.toolCount ?? 0,
						tokens: currentResult.tokens ?? 0,
						durationMs: Date.now() - startTime,
						currentTool: currentResult.currentTool,
						currentToolArgs: currentResult.currentToolArgs,
						recentTools: currentResult.recentTools ?? [],
						lastOutput: currentResult.output,
						usage: {
							input: currentResult.usage.input,
							output: currentResult.usage.output,
							cacheRead: currentResult.usage.cacheRead,
							cacheWrite: currentResult.usage.cacheWrite,
							cost: currentResult.usage.cost,
							turns: currentResult.usage.turns,
						},
					});
					break;

				case "message_update":
					// Extract text from message content for progress display
					const content = event.message?.content;
					if (Array.isArray(content)) {
						const lines: string[] = [];
						for (const block of content) {
							if (block.type === "text" && block.text) {
								lines.push(...block.text.split("\n").filter((l: string) => l.trim()));
							}
						}
						if (lines.length) {
							const tail = lines.slice(-8);
							currentResult.output = tail.join("\n");
							emitUpdate();
							onProgress?.({
								toolCount: currentResult.toolCount ?? 0,
								tokens: currentResult.tokens ?? 0,
								durationMs: Date.now() - startTime,
								currentTool: currentResult.currentTool,
								currentToolArgs: currentResult.currentToolArgs,
								recentTools: currentResult.recentTools ?? [],
								lastOutput: currentResult.output,
								usage: {
									input: currentResult.usage.input,
									output: currentResult.usage.output,
									cacheRead: currentResult.usage.cacheRead,
									cacheWrite: currentResult.usage.cacheWrite,
									cost: currentResult.usage.cost,
									turns: currentResult.usage.turns,
								},
							});
						}
					}
					break;

				case "message_end":
					const msg = event.message as any;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) {
							currentResult.model = msg.model;
						}
						if (msg.stopReason) {
							currentResult.stopReason = msg.stopReason;
						}
						if (msg.errorMessage) {
							currentResult.errorMessage = msg.errorMessage;
						}
						// Collect raw output text
						for (const block of msg.content || []) {
							if (block.type === "text" && block.text) {
								rawOutput += block.text;
							}
						}
					}
					emitUpdate(true);
					onProgress?.({
						toolCount: currentResult.toolCount ?? 0,
						tokens: currentResult.tokens ?? 0,
						durationMs: Date.now() - startTime,
						currentTool: currentResult.currentTool,
						currentToolArgs: currentResult.currentToolArgs,
						recentTools: currentResult.recentTools ?? [],
						lastOutput: currentResult.output,
						usage: {
							input: currentResult.usage.input,
							output: currentResult.usage.output,
							cacheRead: currentResult.usage.cacheRead,
							cacheWrite: currentResult.usage.cacheWrite,
							cost: currentResult.usage.cost,
							turns: currentResult.usage.turns,
						},
					});
					break;
			}
		});

		// Handle abort signal
		if (signal) {
			if (signal.aborted) {
				currentResult.exitCode = 1;
				currentResult.stopReason = "aborted";
				throw new Error("Aborted before start");
			}
			signal.addEventListener(
				"abort",
				() => {
					session.abort();
				},
				{ once: true }
			);
		}

		// Send the task prompt and wait for completion
		await session.prompt(task);

		// Clean up subscription
		unsubscribe();

		// Success
		currentResult.exitCode = 0;
		currentResult.durationMs = Date.now() - startTime;

	} catch (err) {
		currentResult.exitCode = 1;
		currentResult.durationMs = Date.now() - startTime;

		if (err instanceof Error) {
			if (err.message.includes("abort") || err.name === "AbortError") {
				currentResult.stopReason = "aborted";
			} else {
				currentResult.errorMessage = err.message;
				currentResult.stderr = err.message;
			}
		}
	} finally {
		// Restore previous agent identity
		if (previousIdentity !== undefined) {
			process.env.PI_AGENT_IDENTITY = previousIdentity;
		} else {
			delete process.env.PI_AGENT_IDENTITY;
		}
		if (previousModel !== undefined) {
			process.env.PI_MODEL = previousModel;
		} else {
			delete process.env.PI_MODEL;
		}

		// Close JSONL stream
		try {
			jsonlStream.end();
		} catch {}

		// Process final output
		const trunc = truncateOutputHead(rawOutput || currentResult.output || "", outputLimits);
		currentResult.output = trunc.text;
		currentResult.truncated = trunc.truncated;
		currentResult.outputMeta = {
			byteCount: trunc.raw.byteCount,
			lineCount: trunc.raw.lineCount,
			charCount: trunc.raw.charCount,
		};

		// Write output artifact
		try {
			fs.writeFileSync(artifactPaths.outputPath, rawOutput, { encoding: "utf-8", mode: 0o600 });
		} catch {}

		// Write metadata artifact
		try {
			fs.writeFileSync(
				artifactPaths.metadataPath,
				JSON.stringify(
					{
						runId,
						agent: agent.name,
						task,
						model: currentResult.model,
					providerSelection: currentResult.providerSelection,
					failureCategory: currentResult.failureCategory,
						exitCode: currentResult.exitCode,
						startedAt: startTime,
						completedAt: Date.now(),
						durationMs: currentResult.durationMs,
						truncated: currentResult.truncated,
						outputMeta: currentResult.outputMeta,
						outputLimits,
						usage: currentResult.usage,
						stopReason: currentResult.stopReason,
						errorMessage: currentResult.errorMessage,
					},
					null,
					2
				),
				{ encoding: "utf-8", mode: 0o600 }
			);
		} catch {}
		const failureCategory = currentResult.exitCode === 0 ? "success" : classifyProviderFailure(`${currentResult.stderr}
${rawOutput}
${currentResult.errorMessage || ""}`);
		currentResult.failureCategory = failureCategory;
		recordProviderOutcome({
			provider: providerSelection.selectedProvider || inferProviderFromModel(currentResult.model) || "unknown",
			model: currentResult.model,
			agent: agent.name,
			status: failureCategory === "success" ? "success" : failureCategory,
			exitCode: currentResult.exitCode,
			errorMessage: currentResult.errorMessage || currentResult.stderr,
			stopReason: currentResult.stopReason,
		});
	}

	return currentResult;
}

// Cached model registry to avoid recreation on every resolveModel call
let cachedModelRegistry: any = null;
let modelRegistryInitPromise: Promise<any> | null = null;

/**
 * Get or create the cached model registry.
 */
async function getModelRegistry(): Promise<any> {
	if (cachedModelRegistry) return cachedModelRegistry;

	// Prevent concurrent initialization
	if (modelRegistryInitPromise) return modelRegistryInitPromise;

	modelRegistryInitPromise = (async () => {
		try {
			const { discoverModels, discoverAuthStorage } = await import("@mariozechner/pi-coding-agent");

			// Both functions use getDefaultAgentDir() internally as default parameter
			const authStorage = discoverAuthStorage();
			cachedModelRegistry = discoverModels(authStorage);
			return cachedModelRegistry;
		} catch (err) {
			// Clear the promise so future calls can retry
			modelRegistryInitPromise = null;
			throw err;
		}
	})();

	return modelRegistryInitPromise;
}

/**
 * Resolve a model string to a Model object using the SDK's model registry.
 *
 * Supports formats:
 * - "claude-sonnet-4-20250514" (infers provider)
 * - "anthropic/claude-sonnet-4-20250514" (explicit provider)
 *
 * @param modelString - Model identifier string
 * @returns Model object or undefined if not found
 */
async function resolveModel(modelString: string): Promise<any> {
	if (!modelString) return undefined;

	try {
		const modelRegistry = await getModelRegistry();

		// Check for explicit provider/model format
		if (modelString.includes("/")) {
			const [provider, modelId] = modelString.split("/", 2);
			const model = modelRegistry.find(provider, modelId);
			if (model) {
				console.log(`[sdk-runner] Resolved model: ${provider}/${modelId}`);
				return model;
			}
		}

		// Try to infer provider from model ID
		const inferredProvider = inferProvider(modelString);
		if (inferredProvider) {
			const model = modelRegistry.find(inferredProvider, modelString);
			if (model) {
				console.log(`[sdk-runner] Resolved model: ${inferredProvider}/${modelString}`);
				return model;
			}
		}

		// Search all models for matching ID
		const allModels = modelRegistry.getAll();
		const match = allModels.find((m: any) => m.id === modelString);
		if (match) {
			console.log(`[sdk-runner] Resolved model: ${match.provider}/${match.id}`);
			return match;
		}

		// Model not found - log warning and let SDK use default
		console.warn(`[sdk-runner] Model "${modelString}" not found in registry, using SDK default`);
		return undefined;
	} catch (err) {
		console.warn(`[sdk-runner] Failed to resolve model "${modelString}":`, err);
		return undefined;
	}
}

/**
 * Resolve built-in tool names to Tool objects.
 */
async function resolveBuiltinTools(toolNames: string[], cwd: string): Promise<any[]> {
	// Import tool creators from SDK
	const { createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool } =
		await import("@mariozechner/pi-coding-agent");

	const toolMap: Record<string, () => any> = {
		read: () => createReadTool(cwd, {}),
		bash: () => createBashTool(cwd),
		edit: () => createEditTool(cwd),
		write: () => createWriteTool(cwd),
		grep: () => createGrepTool(cwd),
		find: () => createFindTool(cwd),
		ls: () => createLsTool(cwd),
	};

	const tools: any[] = [];
	for (const name of toolNames) {
		const factory = toolMap[name];
		if (factory) {
			tools.push(factory());
		} else {
			console.warn(`[sdk-runner] Unknown built-in tool: ${name}`);
		}
	}

	return tools;
}

/**
 * Check if the SDK is available for use.
 * Can be used to decide whether to fall back to subprocess execution.
 */
export async function isSDKAvailable(): Promise<boolean> {
	return ensureSDK();
}
