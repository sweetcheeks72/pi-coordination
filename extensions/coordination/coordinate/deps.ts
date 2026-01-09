/**
 * Dependency Graph Module
 *
 * Formalizes dependency types between tasks:
 * - blocks: Hard dependency - A must complete before B starts
 * - parent: Structural - B is subtask of A (implicit in TASK-XX.Y)
 * - waits-for: Dynamic - A waits for children to complete
 * - discovered: Audit - B was discovered while working on A
 * - related: Soft - Informational link (no execution effect)
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { Task } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type of dependency relationship.
 */
export type DependencyType =
	| "blocks" // Hard: A must complete before B starts
	| "parent" // Structural: B is subtask of A (implicit in TASK-XX.Y)
	| "waits-for" // Dynamic: A waits for children to complete
	| "discovered" // Audit: B was discovered while working on A
	| "related"; // Soft: Informational link (no execution effect)

/**
 * A dependency relationship between two tasks.
 */
export interface Dependency {
	id: string;
	from: string; // Task ID (the blocked task)
	to: string; // Task ID (the blocker)
	type: DependencyType;
	createdAt: number;
	createdBy: string; // "spec" | worker identity
	metadata?: {
		reason?: string; // For discovered deps
		signature?: string; // For type/function deps
		file?: string; // For file deps
	};
}

/**
 * Full dependency graph.
 */
export interface DependencyGraph {
	version: "1.0";
	dependencies: Dependency[];
}

/**
 * Parsed spec structure (simplified for dep graph).
 */
export interface SpecTask {
	id: string;
	dependsOn: string[];
	parentTaskId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the path to deps.json.
 */
export function getDepsPath(coordDir: string): string {
	return path.join(coordDir, "deps.json");
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph Building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build dependency graph from parsed tasks.
 */
export function buildDependencyGraph(tasks: SpecTask[]): DependencyGraph {
	const deps: Dependency[] = [];
	const now = Date.now();

	for (const task of tasks) {
		// Explicit "Depends on:" become "blocks" type
		for (const depId of task.dependsOn || []) {
			deps.push({
				id: `${task.id}-blocks-${depId}`,
				from: task.id,
				to: depId,
				type: "blocks",
				createdAt: now,
				createdBy: "spec",
			});
		}

		// Subtasks have implicit "parent" dependency
		if (task.parentTaskId) {
			deps.push({
				id: `${task.id}-parent-${task.parentTaskId}`,
				from: task.id,
				to: task.parentTaskId,
				type: "parent",
				createdAt: now,
				createdBy: "spec",
			});
		}

		// Check for implicit parent from TASK-XX.Y format
		const subtaskMatch = task.id.match(/^(TASK-\d+)\.\d+$/);
		if (subtaskMatch && !task.parentTaskId) {
			const parentId = subtaskMatch[1];
			// Only add if parent exists
			if (tasks.some((t) => t.id === parentId)) {
				deps.push({
					id: `${task.id}-parent-${parentId}`,
					from: task.id,
					to: parentId,
					type: "parent",
					createdAt: now,
					createdBy: "spec",
				});
			}
		}
	}

	return { version: "1.0", dependencies: deps };
}

/**
 * Build dependency graph from Task[] (with full Task properties).
 */
export function buildDependencyGraphFromTasks(tasks: Task[]): DependencyGraph {
	return buildDependencyGraph(
		tasks.map((t) => ({
			id: t.id,
			dependsOn: t.dependsOn || [],
			parentTaskId: undefined, // Extract from ID if needed
		})),
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph Persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save dependency graph to disk.
 */
export async function saveDependencyGraph(
	coordDir: string,
	graph: DependencyGraph,
): Promise<void> {
	const depsPath = getDepsPath(coordDir);
	await fs.writeFile(depsPath, JSON.stringify(graph, null, 2));
}

/**
 * Save dependency graph synchronously.
 */
export function saveDependencyGraphSync(
	coordDir: string,
	graph: DependencyGraph,
): void {
	const depsPath = getDepsPath(coordDir);
	fsSync.writeFileSync(depsPath, JSON.stringify(graph, null, 2));
}

/**
 * Load dependency graph from disk.
 */
export async function loadDependencyGraph(
	coordDir: string,
): Promise<DependencyGraph | null> {
	const depsPath = getDepsPath(coordDir);
	try {
		const content = await fs.readFile(depsPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * Load dependency graph synchronously.
 */
export function loadDependencyGraphSync(coordDir: string): DependencyGraph | null {
	const depsPath = getDepsPath(coordDir);
	try {
		const content = fsSync.readFileSync(depsPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph Mutations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a discovered dependency at runtime.
 */
export async function addDiscoveredDependency(
	coordDir: string,
	from: string,
	to: string,
	reason: string,
	createdBy: string,
): Promise<void> {
	let graph = await loadDependencyGraph(coordDir);
	if (!graph) {
		graph = { version: "1.0", dependencies: [] };
	}

	graph.dependencies.push({
		id: `${from}-discovered-${to}-${Date.now()}`,
		from,
		to,
		type: "discovered",
		createdAt: Date.now(),
		createdBy,
		metadata: { reason },
	});

	await saveDependencyGraph(coordDir, graph);
}

/**
 * Add a waits-for dependency (parent waiting for subtasks).
 */
export async function addWaitsForDependency(
	coordDir: string,
	parentId: string,
	childIds: string[],
	createdBy: string,
): Promise<void> {
	let graph = await loadDependencyGraph(coordDir);
	if (!graph) {
		graph = { version: "1.0", dependencies: [] };
	}

	for (const childId of childIds) {
		graph.dependencies.push({
			id: `${parentId}-waits-for-${childId}-${Date.now()}`,
			from: parentId,
			to: childId,
			type: "waits-for",
			createdAt: Date.now(),
			createdBy,
		});
	}

	await saveDependencyGraph(coordDir, graph);
}

/**
 * Add a related (soft) dependency.
 */
export async function addRelatedDependency(
	coordDir: string,
	taskA: string,
	taskB: string,
	reason: string,
	createdBy: string,
): Promise<void> {
	let graph = await loadDependencyGraph(coordDir);
	if (!graph) {
		graph = { version: "1.0", dependencies: [] };
	}

	graph.dependencies.push({
		id: `${taskA}-related-${taskB}-${Date.now()}`,
		from: taskA,
		to: taskB,
		type: "related",
		createdAt: Date.now(),
		createdBy,
		metadata: { reason },
	});

	await saveDependencyGraph(coordDir, graph);
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all blockers for a task.
 */
export function getBlockers(graph: DependencyGraph, taskId: string): string[] {
	return graph.dependencies
		.filter((d) => d.from === taskId && d.type === "blocks")
		.map((d) => d.to);
}

/**
 * Get all tasks blocked by a task.
 */
export function getBlockedBy(graph: DependencyGraph, taskId: string): string[] {
	return graph.dependencies
		.filter((d) => d.to === taskId && d.type === "blocks")
		.map((d) => d.from);
}

/**
 * Get parent task ID if this is a subtask.
 */
export function getParentTask(graph: DependencyGraph, taskId: string): string | null {
	const parentDep = graph.dependencies.find(
		(d) => d.from === taskId && d.type === "parent",
	);
	return parentDep?.to || null;
}

/**
 * Get all subtasks for a parent task.
 */
export function getSubtasks(graph: DependencyGraph, parentId: string): string[] {
	return graph.dependencies
		.filter((d) => d.to === parentId && d.type === "parent")
		.map((d) => d.from);
}

/**
 * Get all tasks this task is waiting for.
 */
export function getWaitingFor(graph: DependencyGraph, taskId: string): string[] {
	return graph.dependencies
		.filter((d) => d.from === taskId && d.type === "waits-for")
		.map((d) => d.to);
}

/**
 * Get all discovered dependencies from a task.
 */
export function getDiscoveredFrom(graph: DependencyGraph, taskId: string): Dependency[] {
	return graph.dependencies.filter(
		(d) => d.createdBy.includes(taskId) && d.type === "discovered",
	);
}

/**
 * Check if task is ready (all blockers completed).
 */
export function isTaskReady(
	graph: DependencyGraph,
	taskId: string,
	completedTasks: Set<string>,
): boolean {
	const blockers = getBlockers(graph, taskId);
	return blockers.every((b) => completedTasks.has(b));
}

/**
 * Check if all subtasks are complete.
 */
export function areSubtasksComplete(
	graph: DependencyGraph,
	parentId: string,
	completedTasks: Set<string>,
): boolean {
	const subtasks = getSubtasks(graph, parentId);
	return subtasks.length > 0 && subtasks.every((s) => completedTasks.has(s));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycle Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect circular dependencies in the graph.
 */
export function detectCycles(graph: DependencyGraph): string[][] {
	const cycles: string[][] = [];
	const visited = new Set<string>();
	const recStack = new Set<string>();

	// Build adjacency list from blocking dependencies only
	const adj = new Map<string, string[]>();
	for (const dep of graph.dependencies) {
		if (dep.type === "blocks") {
			const existing = adj.get(dep.from) || [];
			existing.push(dep.to);
			adj.set(dep.from, existing);
		}
	}

	const dfs = (node: string, path: string[]): boolean => {
		visited.add(node);
		recStack.add(node);

		for (const neighbor of adj.get(node) || []) {
			if (!visited.has(neighbor)) {
				if (dfs(neighbor, [...path, neighbor])) {
					return true;
				}
			} else if (recStack.has(neighbor)) {
				// Found cycle
				const cycleStart = path.indexOf(neighbor);
				if (cycleStart >= 0) {
					cycles.push(path.slice(cycleStart));
				} else {
					cycles.push([...path, neighbor]);
				}
				return true;
			}
		}

		recStack.delete(node);
		return false;
	};

	// Get all nodes
	const allNodes = new Set<string>();
	for (const dep of graph.dependencies) {
		allNodes.add(dep.from);
		allNodes.add(dep.to);
	}

	for (const node of allNodes) {
		if (!visited.has(node)) {
			dfs(node, [node]);
		}
	}

	return cycles;
}

/**
 * Detect cycles from Task[] directly.
 */
export function detectCyclesFromTasks(tasks: SpecTask[]): string[][] {
	const graph = buildDependencyGraph(tasks);
	return detectCycles(graph);
}
