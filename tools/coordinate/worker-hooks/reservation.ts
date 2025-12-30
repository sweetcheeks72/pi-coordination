import type { HookAPI } from "@mariozechner/pi-coding-agent";
import { FileBasedStorage } from "../state.js";

export default function reservationHook(pi: HookAPI) {
	const coordDir = process.env.PI_COORDINATION_DIR;
	const identity = process.env.PI_AGENT_IDENTITY;
	const workerId = process.env.PI_WORKER_ID;

	if (!coordDir || !identity || !workerId) {
		return;
	}

	const storage = new FileBasedStorage(coordDir);

	pi.on("tool_call", async (event) => {
		const { toolName, input } = event;

		if (toolName === "edit" || toolName === "write") {
			const filePath = input.path as string | undefined;
			if (filePath) {
				const reservation = await storage.checkReservation(filePath);
				if (reservation && reservation.agent !== identity && reservation.exclusive) {
					const expiresIn = Math.max(0, Math.floor((reservation.expiresAt - Date.now()) / 1000));
					return {
						block: true,
						reason:
							`File exclusively reserved by ${reservation.agent}: ${filePath}\n` +
							`Reason: ${reservation.reason}\n` +
							`Expires in: ${expiresIn}s\n\n` +
							`Options:\n` +
							`- Wait for the reservation to expire\n` +
							`- Send a message to ${reservation.agent} requesting early release\n` +
							`- Work on different files that aren't reserved`,
					};
				}
			}
		}

		const filePath = (toolName === "edit" || toolName === "write" || toolName === "read")
			? (input.path as string | undefined) ?? null
			: null;

		try {
			await storage.updateWorkerState(workerId, (s) => ({
				...s,
				currentTool: toolName,
				currentFile: filePath,
			}));

			await storage.appendEvent({
				type: "tool_call",
				workerId,
				tool: toolName,
				file: filePath ?? undefined,
				timestamp: Date.now(),
			});
		} catch {}
	});

	pi.on("tool_result", async (event) => {
		const filePath = (event.toolName === "edit" || event.toolName === "write" || event.toolName === "read")
			? (event.input.path as string | undefined) ?? undefined
			: undefined;

		try {
			await storage.appendEvent({
				type: "tool_result",
				workerId,
				tool: event.toolName,
				file: filePath,
				success: !event.isError,
				timestamp: Date.now(),
			});

			const isFileOp = (event.toolName === "edit" || event.toolName === "write") && !event.isError;

			await storage.updateWorkerState(workerId, (s) => ({
				...s,
				currentTool: null,
				currentFile: filePath ?? s.currentFile,
				filesModified: isFileOp && filePath
					? [...new Set([...s.filesModified, filePath])]
					: s.filesModified,
			}));
		} catch {}
	});

	pi.on("turn_end", async (event) => {
		if (event.message.role === "assistant") {
			const msg = event.message as import("@mariozechner/pi-ai").AssistantMessage;
			const usage = msg.usage;
			if (usage) {
				try {
					await storage.updateWorkerState(workerId, (state) => ({
						...state,
						usage: {
							input: state.usage.input + usage.input,
							output: state.usage.output + usage.output,
							cost: state.usage.cost + usage.cost.total,
							turns: state.usage.turns + 1,
						},
					}));
				} catch {}
			}
		}
	});

	pi.on("agent_end", async () => {
		try {
			await storage.updateWorkerState(workerId, (s) => ({
				...s,
				completedAt: s.completedAt ?? Date.now(),
			}));
		} catch {}
	});
}
