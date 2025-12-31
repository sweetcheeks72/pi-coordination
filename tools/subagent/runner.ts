import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { CustomToolAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { getFinalOutput } from "./render.js";
import type { OnUpdateCallback, SingleResult, SubagentDetails } from "./types.js";

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

export async function runSingleAgent(
	pi: CustomToolAPI,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
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

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	
	if (agent.tools && agent.tools.length > 0) {
		const builtinTools: string[] = [];
		const customToolPaths: string[] = [];
		
		for (const t of agent.tools) {
			if (t.includes("/") || t.endsWith(".ts") || t.endsWith(".js")) {
				customToolPaths.push(t);
			} else {
				builtinTools.push(t);
			}
		}
		
		if (builtinTools.length > 0) {
			args.push("--tools", builtinTools.join(","));
		}
		for (const toolPath of customToolPaths) {
			args.push("--tool", toolPath);
		}
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

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
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { cwd: cwd ?? pi.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: process.env });
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				const evt = event as { type?: string; message?: Message };
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
					}
					emitUpdate();
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
				resolve(code ?? 0);
			});

			proc.on("error", () => {
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
		return currentResult;
	} finally {
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch {}
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch {}
	}
}

export async function runParallelAgents(
	pi: CustomToolAPI,
	agents: AgentConfig[],
	tasks: Array<{ agent: string; task: string; cwd?: string }>,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	maxConcurrency: number = 4,
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
				pi,
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
			);
			allResults[current] = result;
			emitParallelUpdate();
		}
	});

	await Promise.all(workers);
	return allResults;
}
