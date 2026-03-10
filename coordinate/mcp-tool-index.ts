/**
 * MCP Tool Index — Lazy tool loading for worker context optimization.
 *
 * Instead of pre-loading all MCP tool schemas (which bloats context by up to 85%),
 * this module:
 * 1. Indexes tools by name + description only (no full schemas)
 * 2. Provides search to find relevant tools by natural language query
 * 3. Lazy-loads full schemas on demand when a worker needs a specific tool
 *
 * @module
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal representation of an MCP server for tool indexing */
export interface MCPServer {
	id: string;
	/** List tools for this server (returns name + description, optionally full schema) */
	listTools(): Promise<MCPToolInfo[]>;
	/** Get the full schema for a specific tool */
	getToolSchema?(toolName: string): Promise<object | null>;
}

/** Raw tool info from an MCP server */
export interface MCPToolInfo {
	name: string;
	description: string;
	inputSchema?: object;
}

/** An entry in the lazy tool index */
export interface ToolIndexEntry {
	name: string;
	description: string;
	serverId: string;
	schemaLoaded: boolean;
	schema?: object; // full JSON schema (lazy-loaded)
}

/** The tool index: lightweight catalog of available tools */
export interface ToolIndex {
	entries: ToolIndexEntry[];
	createdAt: string;
	serverIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Token estimation (simple approximation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rough token count estimator: ~4 chars per token (standard approximation).
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Index construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a tool index from a list of MCP servers.
 * Only fetches name + description — schemas are NOT loaded yet.
 *
 * @param mcpServers - Array of MCP server instances to index
 * @returns A lightweight ToolIndex with name+description entries
 */
export async function buildToolIndex(mcpServers: MCPServer[]): Promise<ToolIndex> {
	const entries: ToolIndexEntry[] = [];
	const serverIds: string[] = [];

	for (const server of mcpServers) {
		serverIds.push(server.id);
		try {
			const tools = await server.listTools();
			for (const tool of tools) {
				entries.push({
					name: tool.name,
					description: tool.description || "",
					serverId: server.id,
					schemaLoaded: tool.inputSchema !== undefined,
					schema: tool.inputSchema,
				});
			}
		} catch (err) {
			console.warn(`[mcp-tool-index] Failed to list tools from server "${server.id}":`, err);
		}
	}

	return {
		entries,
		createdAt: new Date().toISOString(),
		serverIds,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search the tool index by natural language query.
 *
 * Scoring:
 * - Exact name match: +10
 * - Name contains query word: +5 each
 * - Description contains query word: +2 each
 * - Name starts with query word: +3 bonus
 *
 * Returns up to 5 best-matching entries.
 *
 * @param index - The tool index to search
 * @param query - Natural language description of what you need
 * @returns Top matching ToolIndexEntry array (max 5)
 */
export function searchTools(index: ToolIndex, query: string): ToolIndexEntry[] {
	if (!query || !query.trim()) {
		return index.entries.slice(0, 5);
	}

	const normalizedQuery = query.toLowerCase().trim();
	const queryWords = normalizedQuery
		.split(/\s+/)
		.filter((w) => w.length > 1); // filter single chars

	type ScoredEntry = { entry: ToolIndexEntry; score: number };
	const scored: ScoredEntry[] = [];

	for (const entry of index.entries) {
		const nameLower = entry.name.toLowerCase();
		const descLower = entry.description.toLowerCase();

		let score = 0;

		// Exact name match
		if (nameLower === normalizedQuery) {
			score += 10;
		}

		for (const word of queryWords) {
			// Name contains word
			if (nameLower.includes(word)) {
				score += 5;
				// Bonus for starts-with
				if (nameLower.startsWith(word)) {
					score += 3;
				}
			}
			// Description contains word
			if (descLower.includes(word)) {
				score += 2;
			}
		}

		if (score > 0) {
			scored.push({ entry, score });
		}
	}

	// Sort by score descending, then alphabetically for stability
	scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

	return scored.slice(0, 5).map((s) => s.entry);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy schema loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lazy-load the full input schema for a specific tool.
 * Mutates the index entry in place once loaded (caches it for reuse).
 *
 * @param index    - The tool index (mutated to cache loaded schema)
 * @param toolName - Name of the tool to load
 * @param server   - The MCP server that owns this tool
 * @returns The full input schema, or null if not found
 */
export async function loadToolSchema(
	index: ToolIndex,
	toolName: string,
	server: MCPServer,
): Promise<object | null> {
	const entry = index.entries.find(
		(e) => e.name === toolName && e.serverId === server.id,
	);

	if (!entry) {
		console.warn(`[mcp-tool-index] Tool "${toolName}" not found in index for server "${server.id}"`);
		return null;
	}

	// Already loaded — return from cache
	if (entry.schemaLoaded && entry.schema) {
		return entry.schema;
	}

	// Lazy-load from server
	if (server.getToolSchema) {
		try {
			const schema = await server.getToolSchema(toolName);
			if (schema) {
				entry.schema = schema;
				entry.schemaLoaded = true;
				return schema;
			}
		} catch (err) {
			console.warn(`[mcp-tool-index] Failed to load schema for "${toolName}" from "${server.id}":`, err);
		}
	} else {
		// Server doesn't support lazy loading — try listing tools and extracting schema
		try {
			const tools = await server.listTools();
			const tool = tools.find((t) => t.name === toolName);
			if (tool?.inputSchema) {
				entry.schema = tool.inputSchema;
				entry.schemaLoaded = true;
				return tool.inputSchema;
			}
		} catch (err) {
			console.warn(`[mcp-tool-index] Failed to re-list tools for schema of "${toolName}":`, err);
		}
	}

	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact tool list for worker context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a compact, one-line-per-tool summary of available tools.
 *
 * Instead of injecting full JSON schemas into worker context (which can be
 * thousands of tokens), this returns a compact list that tells workers what
 * tools exist, with a prompt to call `search_tools` for full details.
 *
 * Format:
 *   Available tools (search with search_tools): read, bash, write, grep, find, ...
 *   Use search_tools({query: "..."}) to get full details for any tool.
 *
 * @param index - The tool index
 * @returns Compact tool listing string
 */
export function buildCompactToolList(index: ToolIndex): string {
	if (index.entries.length === 0) {
		return "No MCP tools available.";
	}

	const toolNames = index.entries.map((e) => e.name).join(", ");
	const lines = [
		`Available tools (search with search_tools): ${toolNames}`,
		`Use search_tools({query: "..."}) to get full details for any tool before using it.`,
	];

	return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Token savings tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute and log token savings from lazy loading vs eager loading.
 *
 * @param index          - Tool index (may have some schemas loaded, some not)
 * @param allSchemasJSON - JSON string of what all schemas would have been
 * @returns The number of tokens saved
 */
export function logTokenSavings(index: ToolIndex, allSchemasJSON: string): number {
	const compactList = buildCompactToolList(index);
	const fullSchemaTokens = estimateTokens(allSchemasJSON);
	const compactTokens = estimateTokens(compactList);
	const savedTokens = fullSchemaTokens - compactTokens;

	if (savedTokens > 0) {
		const pct = Math.round((savedTokens / fullSchemaTokens) * 100);
		console.log(
			`[mcp-lazy] Saved ~${savedTokens} tokens by lazy-loading tool schemas ` +
			`(${pct}% reduction: ${fullSchemaTokens} → ${compactTokens})`,
		);
	}

	return savedTokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic search_tools tool definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `search_tools` synthetic tool definition.
 * Add this to a worker's available tools so it can discover tool schemas
 * on demand without having all schemas pre-loaded into context.
 */
export const SEARCH_TOOLS_TOOL = {
	name: "search_tools",
	description:
		"Search for available tools by capability. Returns matching tool names and descriptions. " +
		"Use this before calling any tool to get its full schema.",
	inputSchema: {
		type: "object" as const,
		properties: {
			query: {
				type: "string",
				description: "Natural language description of what you need (e.g., 'list files', 'run bash command')",
			},
		},
		required: ["query"],
	},
};

/**
 * Handle a `search_tools` tool call from a worker.
 *
 * @param index - The current tool index
 * @param query - The worker's natural language query
 * @returns Formatted search results string
 */
export function handleSearchToolsCall(index: ToolIndex, query: string): string {
	const results = searchTools(index, query);

	if (results.length === 0) {
		return `No tools found matching "${query}". Available tool names: ${index.entries.map((e) => e.name).join(", ")}`;
	}

	const lines = [`Found ${results.length} tool(s) matching "${query}":\n`];
	for (const entry of results) {
		lines.push(`• **${entry.name}** (server: ${entry.serverId})`);
		if (entry.description) {
			lines.push(`  ${entry.description}`);
		}
		if (entry.schemaLoaded && entry.schema) {
			lines.push(`  Schema: ${JSON.stringify(entry.schema, null, 2)}`);
		} else {
			lines.push(`  (Schema not yet loaded — call this tool and the schema will be fetched on demand)`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
