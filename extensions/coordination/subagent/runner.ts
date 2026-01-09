import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.js";
import { getFinalOutput, getResultOutput } from "./render.js";
import { createArtifactPaths } from "./artifacts.js";
import { truncateOutputHead } from "./truncate.js";
import type { OnUpdateCallback, OutputLimits, SingleResult, SubagentDetails } from "./types.js";
import { runAgentSDK, isSDKAvailable } from "./sdk-runner.js";

const UPDATE_THROTTLE_MS = 250;
const MAX_RECENT_TOOLS = 5;

export interface AgentRuntime {
	cwd: string;
}

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

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

export async function runSingleAgent(
	runtime: AgentRuntime,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	options?: { outputLimits?: OutputLimits; artifactsDir?: string; artifactLabel?: string; extensions?: string[]; attachments?: string[]; useSubprocess?: boolean },
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: ${agentName}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// Try to use SDK runner if available (unless explicitly using subprocess)
	if (!options?.useSubprocess && await isSDKAvailable()) {
		return runAgentSDK({
			cwd: cwd ?? runtime.cwd,
			agent,
			task,
			signal,
			onUpdate,
			makeDetails,
			outputLimits: options?.outputLimits,
			artifactsDir: options?.artifactsDir,
			artifactLabel: options?.artifactLabel,
			step,
			extensions: options?.extensions,
		});
	}

	// Fall back to subprocess execution
	// Log agent configuration for observability
	const hasTools = agent.tools && agent.tools.length > 0;
	const toolsList = hasTools 
		? agent.tools!.join(", ") 
		: (agent.systemPromptMode === "override" ? "NONE" : "default");
	const modeLabel = agent.systemPromptMode === "override" ? "override" : "append";
	console.log(`[subagent] ${agentName}: model=${agent.model || "default"}, tools=[${toolsList}], prompt=${modeLabel}`);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	
	if (agent.tools && agent.tools.length > 0) {
		const builtinTools: string[] = [];
		const extensionPaths: string[] = [];

		for (const t of agent.tools) {
			if (t.includes("/") || t.endsWith(".ts") || t.endsWith(".js")) {
				extensionPaths.push(t);
			} else {
				builtinTools.push(t);
			}
		}

		if (builtinTools.length > 0) {
			args.push("--tools", builtinTools.join(","));
		}
		for (const extPath of extensionPaths) {
			args.push("--extension", extPath);
		}
	}

	if (options?.extensions && options.extensions.length > 0) {
		for (const extPath of options.extensions) {
			args.push("--extension", extPath);
		}
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const startTime = Date.now();
	const runId = randomUUID();
	const artifactPaths = createArtifactPaths(options?.artifactLabel ?? agentName, runId, options?.artifactsDir);

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
		artifactPaths,
		toolCount: 0,
		recentTools: [],
	};

	let lastUpdateMs = 0;
	const emitUpdate = (force = false) => {
		if (onUpdate) {
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
				content: [{ type: "text", text: getResultOutput(currentResult) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	const systemPrompt = agent.systemPrompt.trim();
	const inputContent = systemPrompt
		? `# System Prompt\n\n${systemPrompt}\n\n# Task\n\n${task}`
		: task;

	try {
		fs.writeFileSync(artifactPaths.inputPath, inputContent, { encoding: "utf-8", mode: 0o600 });
	} catch {}

	const jsonlStream = fs.createWriteStream(artifactPaths.jsonlPath, { flags: "a" });

	try {
		if (systemPrompt) {
			const tmp = writePromptToTempFile(agent.name, systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			// Use --system-prompt for complete override, --append-system-prompt to add to default
			const promptFlag = agent.systemPromptMode === "override" ? "--system-prompt" : "--append-system-prompt";
			args.push(promptFlag, tmpPromptPath);
		}

		// Add file attachments (included in initial message via @file syntax)
		if (options?.attachments && options.attachments.length > 0) {
			for (const attachment of options.attachments) {
				args.push(`@${attachment}`);
			}
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let rawOutput = "";

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { cwd: cwd ?? runtime.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: process.env });
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					jsonlStream.write(line + "\n");
				} catch {}
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				const evt = event as {
					type?: string;
					message?: Message;
					toolName?: string;
					toolArgs?: Record<string, unknown>;
					args?: Record<string, unknown>;
					result?: { content?: Array<{ type: string; text?: string }> };
				};

				if (evt.type === "tool_execution_start" && evt.toolName) {
					currentResult.toolCount = (currentResult.toolCount ?? 0) + 1;
					currentResult.currentTool = evt.toolName;
					currentResult.currentToolArgs = extractToolArgsPreview(evt.toolArgs || evt.args || {}) || undefined;
					emitUpdate();
				}

				if (evt.type === "tool_execution_end" && evt.toolName) {
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
				}

				if (evt.type === "message_update") {
					const updateContent = evt.message?.content ?? evt.result?.content ?? (evt as any).content;
					if (Array.isArray(updateContent)) {
						const lines: string[] = [];
						for (const block of updateContent) {
							if (block.type === "text" && block.text) {
								lines.push(...block.text.split("\n").filter((l) => l.trim()));
							}
						}
						if (lines.length) {
							const tail = lines.slice(-8);
							currentResult.output = tail.join("\n");
							emitUpdate();
						}
					}
				}

				if (evt.type === "message_end" && evt.message) {
					const msg = evt.message;
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
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						for (const block of msg.content) {
							if (block.type === "text" && block.text) {
								rawOutput += block.text;
							}
						}
					}
					emitUpdate(true);
				}

				if (evt.type === "tool_result_end" && evt.message) {
					currentResult.messages.push(evt.message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				try {
					jsonlStream.end();
				} catch {}
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				try {
					jsonlStream.end();
				} catch {}
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) currentResult.stopReason = "aborted";
		currentResult.durationMs = Date.now() - startTime;

		const finalOutput = getFinalOutput(currentResult.messages);
		const raw = finalOutput || rawOutput || currentResult.output || "";
		const trunc = truncateOutputHead(raw, options?.outputLimits);
		currentResult.output = trunc.text;
		currentResult.truncated = trunc.truncated;
		currentResult.outputMeta = {
			byteCount: trunc.raw.byteCount,
			lineCount: trunc.raw.lineCount,
			charCount: trunc.raw.charCount,
		};

		try {
			fs.writeFileSync(artifactPaths.outputPath, raw, { encoding: "utf-8", mode: 0o600 });
		} catch {}

		try {
			fs.writeFileSync(
				artifactPaths.metadataPath,
				JSON.stringify(
					{
						runId,
						agent: agentName,
						task,
						model: currentResult.model,
						exitCode,
						startedAt: startTime,
						completedAt: Date.now(),
						durationMs: currentResult.durationMs,
						truncated: currentResult.truncated,
						outputMeta: currentResult.outputMeta,
						outputLimits: options?.outputLimits,
						usage: currentResult.usage,
						stopReason: currentResult.stopReason,
						errorMessage: currentResult.errorMessage,
					},
					null,
					2,
				),
				{ encoding: "utf-8", mode: 0o600 },
			);
		} catch {}
		return currentResult;
	} finally {
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch {}
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch {}
	}
}

export async function runParallelAgents(
	runtime: AgentRuntime,
	agents: AgentConfig[],
	tasks: Array<{ agent: string; task: string; cwd?: string }>,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	maxConcurrency: number = 4,
	options?: { outputLimits?: OutputLimits; artifactsDir?: string; extensions?: string[] },
): Promise<SingleResult[]> {
	const allResults: SingleResult[] = new Array(tasks.length);

	for (let i = 0; i < tasks.length; i++) {
		allResults[i] = {
			agent: tasks[i].agent,
			agentSource: "unknown",
			task: tasks[i].task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const emitParallelUpdate = () => {
		if (onUpdate) {
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			onUpdate({
				content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
				details: makeDetails([...allResults]),
			});
		}
	};

	let nextIndex = 0;
	const limit = Math.max(1, Math.min(maxConcurrency, tasks.length));

	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= tasks.length) return;

			const t = tasks[current];
			const result = await runSingleAgent(
				runtime,
				agents,
				t.agent,
				t.task,
				t.cwd,
				undefined,
				signal,
				(partial) => {
					if (partial.details?.results[0]) {
						allResults[current] = partial.details.results[0];
						emitParallelUpdate();
					}
				},
				makeDetails,
				{
					outputLimits: options?.outputLimits,
					artifactsDir: options?.artifactsDir,
					artifactLabel: `${t.agent}-${current + 1}`,
					extensions: options?.extensions,
				},
			);
			allResults[current] = result;
			emitParallelUpdate();
		}
	});

	await Promise.all(workers);
	return allResults;
}
