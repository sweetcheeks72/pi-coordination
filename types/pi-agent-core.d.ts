/**
 * Stub type declarations for @mariozechner/pi-agent-core
 * These types are re-exported/augmented by @mariozechner/pi-coding-agent
 */
declare module "@mariozechner/pi-agent-core" {
	export interface AgentToolResult<TDetails = unknown> {
		content: Array<{ type: "text"; text: string }>;
		details?: TDetails;
		isError?: boolean;
	}

	export type AgentToolUpdateCallback<TDetails = unknown> = (
		partial: AgentToolResult<TDetails>,
	) => void;

	// eslint-disable-next-line @typescript-eslint/no-empty-interface
	export interface CustomAgentMessages {}

	export type AgentMessageBase = {
		role: string;
		id?: string;
		timestamp?: number;
	};

	export type AgentMessage =
		| { role: "user"; content: string | Array<{ type: string; [k: string]: unknown }>; id?: string; timestamp?: number }
		| { role: "assistant"; content: string | Array<{ type: string; [k: string]: unknown }>; id?: string; timestamp?: number; usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: { total: number }; [k: string]: unknown } }
		| { role: "tool_result"; toolCallId: string; content: string; id?: string; timestamp?: number }
		| { role: string; id?: string; timestamp?: number; [k: string]: unknown };

	export type ThinkingLevel = "low" | "medium" | "high" | "none";

	export interface AgentTool {
		name: string;
		description: string;
		[k: string]: unknown;
	}

	export interface AgentState {
		[k: string]: unknown;
	}

	export interface AgentEvent {
		type: string;
		[k: string]: unknown;
	}

	export interface Agent {
		[k: string]: unknown;
	}
}
