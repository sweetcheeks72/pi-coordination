/**
 * Stub type declarations for @mariozechner/pi-ai
 * These types are used by @mariozechner/pi-coding-agent
 */
declare module "@mariozechner/pi-ai" {
	export type TextContent = { type: "text"; text: string };
	export type ImageContent = { type: "image"; source: { type: string; data?: string; url?: string; mediaType?: string }; [k: string]: unknown };

	export type Message =
		| { role: "user"; content: string | Array<TextContent | ImageContent>; [k: string]: unknown }
		| { role: "assistant"; content: string | Array<{ type: string; [k: string]: unknown }>; usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: { total: number } }; [k: string]: unknown }
		| { role: "tool_result"; toolCallId: string; content: string; [k: string]: unknown }
		| { role: string; [k: string]: unknown };

	export type AssistantMessage = {
		role: "assistant";
		content: string | Array<{ type: string; [k: string]: unknown }>;
		usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: { total: number } };
		[k: string]: unknown;
	};

	export interface Model<T = unknown> {
		id: string;
		name?: string;
		provider?: string;
		[k: string]: unknown;
	}

	export interface Api {
		[k: string]: unknown;
	}

	export interface Context {
		[k: string]: unknown;
	}

	export interface SimpleStreamOptions {
		[k: string]: unknown;
	}

	export interface AssistantMessageEvent {
		[k: string]: unknown;
	}

	export interface AssistantMessageEventStream {
		[k: string]: unknown;
	}

	export interface OAuthCredentials {
		[k: string]: unknown;
	}

	export interface OAuthLoginCallbacks {
		[k: string]: unknown;
	}

	export interface ToolResultMessage {
		[k: string]: unknown;
	}

	export type KnownProvider = string;
	export type Transport = unknown;
}
