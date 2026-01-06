import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerWorkerTools } from "../../tools/coordinate/worker-tools/index.js";
import { consumeNudgeSync } from "../../tools/coordinate/nudge.js";
import { A2AManager } from "../../tools/coordinate/a2a.js";

function getSelfReviewPrompt(specPath?: string): string {
	const specInstruction = specPath
		? `\n\nMake sure you re-read the spec before you review:\n${specPath}\n`
		: "";

	return `Great, now I want you to carefully read over all of the new code you just wrote and other existing code you just modified with "fresh eyes," looking super carefully for any obvious bugs, errors, problems, issues, confusion, etc.${specInstruction}
If any issues are found, proceed to fix them without being asked to do so. If no issues are found then your response MUST contain these exact words: "No issues found."`;
}

interface SelfReviewState {
	count: number;
	passed: boolean;
	pendingCompletion: { result: string; filesModified?: string[] } | null;
}

function extractTextFromMessage(message: unknown): string {
	const msg = message as { role?: string; content?: Array<{ type: string; text?: string }> };
	if (!msg || msg.role !== "assistant") return "";
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((block) => block.type === "text")
		.map((block) => block.text || "")
		.join("\n");
}

export default function registerWorkerExtension(pi: ExtensionAPI): void {
	const coordDir = process.env.PI_COORDINATION_DIR;
	const workerId = process.env.PI_WORKER_ID;
	const identity = process.env.PI_AGENT_IDENTITY;
	const maxSelfReviewCycles = parseInt(process.env.PI_MAX_SELF_REVIEW_CYCLES || "5");
	const selfReviewEnabled = process.env.PI_SELF_REVIEW_ENABLED !== "false";
	const specPath = process.env.PI_SELF_REVIEW_SPEC_PATH;

	registerWorkerTools(pi);

	if (!coordDir || !workerId || !identity) return;

	const selfReview: SelfReviewState = {
		count: 0,
		passed: false,
		pendingCompletion: null,
	};

	const a2a = new A2AManager(coordDir);
	let lastA2ACheck = Date.now();

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "complete_task") return;

		if (!selfReviewEnabled) return;

		if (selfReview.passed) return;

		selfReview.pendingCompletion = {
			result: event.input.result as string,
			filesModified: event.input.filesModified as string[] | undefined,
		};

		return {
			block: true,
			reason: "Self-review required before completion. Initiating review...",
		};
	});

	pi.on("agent_end", async (event) => {
		if (!selfReviewEnabled) return;
		if (!selfReview.pendingCompletion) return;

		const messages = (event as { messages?: unknown[] }).messages;
		if (!messages || messages.length === 0) return;

		const lastMessage = messages[messages.length - 1];
		const text = extractTextFromMessage(lastMessage);

		if (text.includes("No issues found.")) {
			selfReview.passed = true;

			emitEvent("self_review_passed", { cycleNumber: selfReview.count });
			selfReview.count = 0;

			pi.sendMessage(
				{
					customType: "self-review-complete",
					content: `Self-review passed. Now call complete_task() with your original summary: "${selfReview.pendingCompletion.result}"`,
					display: true,
				},
				{ triggerTurn: true },
			);
			return;
		}

		if (selfReview.count >= maxSelfReviewCycles) {
			selfReview.passed = true;

			emitEvent("self_review_limit_reached", { maxCycles: maxSelfReviewCycles });

			pi.sendMessage(
				{
					customType: "self-review-limit",
					content: `Max self-review cycles (${maxSelfReviewCycles}) reached. Proceeding. Call complete_task() now with: "${selfReview.pendingCompletion.result}"`,
					display: true,
				},
				{ triggerTurn: true },
			);
			return;
		}

		selfReview.count++;

		emitEvent("self_review_started", { cycleNumber: selfReview.count });

		pi.sendMessage(
			{
				customType: "self-review",
				content: getSelfReviewPrompt(specPath),
				display: true,
			},
			{ triggerTurn: true },
		);
	});

	pi.on("turn_start", async () => {
		const nudge = consumeNudgeSync(coordDir, workerId);
		if (nudge) {
			emitEvent("worker_nudged", { nudgeType: nudge.type });

			switch (nudge.type) {
				case "wrap_up":
					pi.sendMessage(
						{
							customType: "nudge",
							content: `[Supervisor] ${nudge.message}`,
							display: true,
						},
						{ triggerTurn: false },
					);
					break;

				case "restart":
					process.exit(42);

				case "abort":
					process.exit(1);
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

	function emitEvent(type: string, data: Record<string, unknown>): void {
		try {
			const eventLine = JSON.stringify({
				type,
				workerId,
				identity,
				timestamp: Date.now(),
				...data,
			});
			fs.appendFileSync(path.join(coordDir, "events.jsonl"), eventLine + "\n");
		} catch {}
	}
}
