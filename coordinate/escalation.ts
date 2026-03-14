/**
 * Dual-surface escalation: TUI (number keys) + HTML interview (browser).
 *
 * Architecture:
 *   1. Worker calls escalate_to_user → writes to escalations.jsonl
 *   2. EscalationManager generates an HTML file and optionally opens the browser
 *   3. HTML POSTs the user's choice to a local HTTP server (default port 7799)
 *   4. HTTP server (or TUI) writes escalation-responses/<id>.json
 *   5. escalate_to_user polls for that file; on timeout uses agentAssumption
 */

import * as fsSync from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { EscalationRequest, EscalationOption, EscalationResponse } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ESCALATION_PORT = 7799;
export const DEFAULT_ESCALATION_TIMEOUT_SECS = 300; // 5 minutes

// ─────────────────────────────────────────────────────────────────────────────
// HTML generation (Pyramid Principle)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Feynman restatement of the question:
 * Simpler phrasing that strips jargon.
 */
function feynmanRestate(question: string): string {
	// Minimal heuristic: strip markdown, trim, add "In other words: ..."
	const clean = question
		.replace(/[#*`_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (clean.length < 30) return clean;
	// If it ends with a question mark, rephrase slightly
	if (clean.endsWith("?")) {
		return `The agent needs to know: ${clean}`;
	}
	return `The decision needed: ${clean}`;
}

/**
 * Generate the HTML interview for an escalation request.
 * Follows Pyramid Principle:
 *   Tier 1  – Lead with question
 *   Feynman – Plain-language restatement
 *   Tier 2  – Context card (plan intent, state, assumptions)
 *   Options  – Numbered buttons with tradeoffs
 *   Footer   – Agent assumption + auto-proceed countdown
 */
export function generateEscalationHTML(
	req: EscalationRequest,
	serverPort: number = DEFAULT_ESCALATION_PORT,
): string {
	const options: EscalationOption[] = req.richOptions?.length
		? req.richOptions
		: req.options.map((o) => ({ label: o }));

	const feynman = feynmanRestate(req.question);
	const confidencePct =
		req.confidence != null ? Math.round(req.confidence * 100) : null;
	const assumptionText =
		req.agentAssumption ||
		(options[req.defaultOption ?? 0]?.label ?? options[0]?.label ?? "Proceed with default");

	const optionButtons = options
		.map((opt, i) => {
			const num = i + 1;
			const descHtml = opt.description
				? `<p class="opt-desc">${escHtml(opt.description)}</p>`
				: "";
			return `
		<button class="option-btn" onclick="respond(${num}, ${JSON.stringify(opt.label)})">
			<span class="opt-num">${num}</span>
			<span class="opt-content">
				<strong class="opt-label">${escHtml(opt.label)}</strong>
				${descHtml}
			</span>
		</button>`;
		})
		.join("\n");

	const contextSection = req.context
		? `
		<section class="context-card">
			<h2>Context</h2>
			<pre class="context-pre">${escHtml(req.context)}</pre>
		</section>`
		: "";

	const confidenceNote = confidencePct != null
		? ` <span class="confidence">(${confidencePct}% confidence)</span>`
		: "";

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8"/>
	<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
	<title>Agent Escalation — ${escHtml(req.id.slice(0, 8))}</title>
	<style>
		:root {
			--bg: #0f1117;
			--bg2: #1a1d2e;
			--border: #2e3148;
			--accent: #7b8cde;
			--success: #4caf82;
			--warn: #e2a03f;
			--text: #cdd6f4;
			--muted: #6c7086;
			--danger: #f38ba8;
			--radius: 8px;
			--font: 'SF Mono', 'Fira Code', Consolas, monospace;
		}

		* { box-sizing: border-box; margin: 0; padding: 0; }

		body {
			background: var(--bg);
			color: var(--text);
			font-family: var(--font);
			font-size: 14px;
			line-height: 1.6;
			max-width: 820px;
			margin: 0 auto;
			padding: 32px 24px 64px;
		}

		/* ─── Tier 1: Question ─── */
		.question-badge {
			display: inline-block;
			padding: 2px 10px;
			border-radius: 12px;
			background: var(--accent);
			color: var(--bg);
			font-size: 11px;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			margin-bottom: 12px;
		}
		h1.question-text {
			font-size: 22px;
			font-weight: 700;
			color: #fff;
			margin-bottom: 10px;
			line-height: 1.4;
		}
		.feynman {
			color: var(--muted);
			font-size: 13px;
			margin-bottom: 28px;
			padding-left: 12px;
			border-left: 3px solid var(--border);
		}

		/* ─── Context card ─── */
		.context-card {
			background: var(--bg2);
			border: 1px solid var(--border);
			border-radius: var(--radius);
			padding: 16px 20px;
			margin-bottom: 28px;
		}
		.context-card h2 {
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--muted);
			margin-bottom: 10px;
		}
		.context-pre {
			white-space: pre-wrap;
			word-break: break-word;
			font-size: 12px;
			color: var(--text);
			line-height: 1.5;
		}

		/* ─── Options ─── */
		.options-section h2 {
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--muted);
			margin-bottom: 14px;
		}
		.option-btn {
			display: flex;
			align-items: flex-start;
			gap: 14px;
			width: 100%;
			background: var(--bg2);
			border: 1px solid var(--border);
			border-radius: var(--radius);
			padding: 14px 18px;
			margin-bottom: 10px;
			cursor: pointer;
			color: var(--text);
			text-align: left;
			transition: border-color 0.12s, background 0.12s;
			font-family: var(--font);
		}
		.option-btn:hover {
			border-color: var(--accent);
			background: #23263d;
		}
		.option-btn:active {
			background: #2e3158;
		}
		.opt-num {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 28px;
			height: 28px;
			border-radius: 6px;
			background: var(--accent);
			color: var(--bg);
			font-weight: 700;
			font-size: 13px;
			flex-shrink: 0;
		}
		.opt-content { flex: 1; }
		.opt-label {
			font-size: 14px;
			color: #fff;
			display: block;
			margin-bottom: 4px;
		}
		.opt-desc {
			font-size: 12px;
			color: var(--muted);
		}

		/* ─── Custom answer ─── */
		.custom-section {
			margin-top: 16px;
			display: flex;
			gap: 8px;
		}
		.custom-input {
			flex: 1;
			background: var(--bg2);
			border: 1px solid var(--border);
			border-radius: var(--radius);
			padding: 10px 14px;
			color: var(--text);
			font-family: var(--font);
			font-size: 14px;
		}
		.custom-input:focus {
			outline: none;
			border-color: var(--accent);
		}
		.custom-btn {
			background: var(--accent);
			color: var(--bg);
			border: none;
			border-radius: var(--radius);
			padding: 10px 18px;
			cursor: pointer;
			font-weight: 600;
			font-family: var(--font);
			font-size: 14px;
		}

		/* ─── Auto-proceed footer ─── */
		.auto-proceed {
			margin-top: 36px;
			padding: 14px 18px;
			border: 1px solid var(--border);
			border-radius: var(--radius);
			background: rgba(226, 160, 63, 0.08);
		}
		.auto-proceed-label {
			font-size: 11px;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--warn);
			margin-bottom: 8px;
		}
		.assume-text {
			font-size: 13px;
			color: var(--text);
			margin-bottom: 6px;
		}
		.countdown-row {
			font-size: 12px;
			color: var(--muted);
		}
		#countdown { color: var(--warn); font-weight: 700; }

		/* ─── Response confirmation ─── */
		#response-confirm {
			display: none;
			margin-top: 24px;
			padding: 16px 20px;
			background: rgba(76, 175, 130, 0.12);
			border: 1px solid var(--success);
			border-radius: var(--radius);
			color: var(--success);
			font-size: 14px;
		}

		/* ─── Error box ─── */
		#error-box {
			display: none;
			margin-top: 24px;
			padding: 14px 18px;
			background: rgba(243, 139, 168, 0.10);
			border: 1px solid var(--danger);
			border-radius: var(--radius);
			color: var(--danger);
			font-size: 13px;
		}

		/* ─── Meta ─── */
		.meta {
			margin-top: 36px;
			font-size: 11px;
			color: var(--muted);
			display: flex;
			gap: 16px;
			flex-wrap: wrap;
		}
		kbd {
			background: var(--bg2);
			border: 1px solid var(--border);
			border-radius: 4px;
			padding: 1px 6px;
			font-family: var(--font);
			font-size: 11px;
		}
	</style>
</head>
<body>

	<!-- Tier 1: Lead with question -->
	<div class="question-badge">Agent Escalation</div>
	<h1 class="question-text">${escHtml(req.question)}</h1>
	<p class="feynman">${escHtml(feynman)}</p>

	<!-- Tier 2: Context card -->
	${contextSection}

	<!-- Options -->
	<section class="options-section">
		<h2>Options — press <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> or click</h2>
		${optionButtons}

		<!-- Free-form custom answer -->
		<div class="custom-section">
			<input
				id="custom-input"
				class="custom-input"
				type="text"
				placeholder=":answer  free-form response…"
			/>
			<button class="custom-btn" onclick="respondCustom()">Send</button>
		</div>
	</section>

	<!-- Agent assumption + auto-proceed countdown -->
	<div class="auto-proceed">
		<div class="auto-proceed-label">⚡ Auto-proceed</div>
		<p class="assume-text">
			Agent assumes: <strong>${escHtml(assumptionText)}</strong>${confidenceNote}
		</p>
		<p class="countdown-row">
			Proceeding automatically in <span id="countdown">${req.timeout}</span>s unless you respond.
		</p>
	</div>

	<div id="response-confirm">
		✓ Response recorded — the agent will continue.
	</div>
	<div id="error-box"></div>

	<!-- Meta -->
	<div class="meta">
		<span>id: ${escHtml(req.id)}</span>
		<span>from: ${escHtml(req.from)}</span>
	</div>

	<script>
		const ESCALATION_ID = ${JSON.stringify(req.id)};
		const SERVER_URL = ${JSON.stringify(`http://localhost:${serverPort}/respond`)};
		let responded = false;
		let secondsLeft = ${req.timeout};

		// ─── Countdown ───
		const countdownEl = document.getElementById('countdown');
		const timer = setInterval(() => {
			secondsLeft--;
			if (countdownEl) countdownEl.textContent = String(Math.max(0, secondsLeft));
			if (secondsLeft <= 0) {
				clearInterval(timer);
				if (!responded) {
					showConfirm('Auto-proceeded with: ${escJsStr(assumptionText)}');
				}
			}
		}, 1000);

		// ─── Keyboard shortcuts ───
		document.addEventListener('keydown', (e) => {
			const idx = parseInt(e.key, 10);
			if (!isNaN(idx) && idx >= 1 && idx <= ${options.length}) {
				const labels = ${JSON.stringify(options.map((o) => o.label))};
				respond(idx, labels[idx - 1]);
			}
		});

		// ─── Custom input: Enter key ───
		const customInput = document.getElementById('custom-input');
		customInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') respondCustom();
		});

		// ─── respond functions ───
		async function respond(num, choice) {
			if (responded) return;
			try {
				const res = await fetch(SERVER_URL, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id: ESCALATION_ID, choice, optionIndex: num - 1 }),
					mode: 'cors',
				});
				if (!res.ok) throw new Error('Server returned ' + res.status);
				responded = true;
				clearInterval(timer);
				showConfirm('Response recorded: ' + choice);
			} catch (err) {
				showError(
					'Could not reach the coordination server at ' + SERVER_URL + '.\\n' +
					'You can also answer via the TUI using :answer ' + choice
				);
			}
		}

		function respondCustom() {
			const input = document.getElementById('custom-input');
			const val = input.value.trim();
			if (!val) return;
			respond(0, val);
		}

		function showConfirm(msg) {
			const el = document.getElementById('response-confirm');
			el.textContent = '✓ ' + msg;
			el.style.display = 'block';
			document.querySelector('.options-section').style.opacity = '0.4';
			document.querySelector('.options-section').style.pointerEvents = 'none';
		}

		function showError(msg) {
			const el = document.getElementById('error-box');
			el.textContent = '⚠ ' + msg;
			el.style.display = 'block';
		}
	</script>
</body>
</html>`;

	return html;
}

/** Escape HTML special characters */
function escHtml(str: string): string {
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Escape for JS string literal (no quotes added) */
function escJsStr(str: string): string {
	return String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ─────────────────────────────────────────────────────────────────────────────
// File I/O helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Write escalation HTML to coordDir/interviews/escalation-<id>.html */
export function writeEscalationHTML(coordDir: string, req: EscalationRequest, serverPort?: number): string {
	const interviewsDir = path.join(coordDir, "interviews");
	fsSync.mkdirSync(interviewsDir, { recursive: true });
	const htmlPath = path.join(interviewsDir, `escalation-${req.id}.html`);
	const html = generateEscalationHTML(req, serverPort);
	fsSync.writeFileSync(htmlPath, html, { encoding: "utf-8" });
	return htmlPath;
}

/** Write escalation response to coordDir/escalation-responses/<id>.json */
export function writeEscalationResponseFile(
	coordDir: string,
	id: string,
	choice: string,
	wasTimeout: boolean,
): void {
	const responsesDir = path.join(coordDir, "escalation-responses");
	fsSync.mkdirSync(responsesDir, { recursive: true });
	const response: EscalationResponse = {
		id,
		choice,
		wasTimeout,
		respondedAt: Date.now(),
	};
	fsSync.writeFileSync(
		path.join(responsesDir, `${id}.json`),
		JSON.stringify(response, null, 2),
	);
}

/** Open an HTML file in the system browser. Best-effort — failures are ignored. */
export function openInBrowser(htmlPath: string): void {
	try {
		const url = `file://${htmlPath}`;
		const platform = process.platform;
		if (platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		} else if (platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
		} else {
			// Linux / other — try xdg-open
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		// best-effort
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────

interface EscalationServerState {
	server: http.Server;
	port: number;
}

let _serverState: EscalationServerState | null = null;

/**
 * Start (or return existing) HTTP server that accepts browser responses.
 * Handles POST /respond  { id, choice }
 * Returns 200 on success, 409 if already responded, 404 if not found.
 */
export function startEscalationServer(
	coordDir: string,
	port: number = DEFAULT_ESCALATION_PORT,
): EscalationServerState {
	if (_serverState && _serverState.server.listening) {
		return _serverState;
	}

	const server = http.createServer((req, res) => {
		// CORS headers — required because HTML is opened from file://
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (req.method === "POST" && req.url === "/respond") {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				try {
					const payload = JSON.parse(body) as { id?: string; choice?: string };
					if (!payload.id || !payload.choice) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Missing id or choice" }));
						return;
					}

					// Check if already responded
					const responsePath = path.join(coordDir, "escalation-responses", `${payload.id}.json`);
					if (fsSync.existsSync(responsePath)) {
						res.writeHead(409, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Already responded" }));
						return;
					}

					writeEscalationResponseFile(coordDir, payload.id, payload.choice, false);

					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, id: payload.id, choice: payload.choice }));
				} catch {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Parse error" }));
				}
			});
			return;
		}

		res.writeHead(404);
		res.end();
	});

	// Try to listen; if port is in use, skip silently (TUI still works)
	server.on("error", () => {
		// Port conflict — browser surface unavailable but TUI still works
	});
	server.listen(port, "127.0.0.1");

	_serverState = { server, port };
	return _serverState;
}

/** Stop the HTTP server if running */
export function stopEscalationServer(): void {
	if (_serverState) {
		_serverState.server.close();
		_serverState = null;
	}
}

/** Get the current server port, or null if not running */
export function getEscalationServerPort(): number | null {
	if (_serverState?.server.listening) return _serverState.port;
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read escalations from JSONL
// ─────────────────────────────────────────────────────────────────────────────

/** Read all escalation requests from escalations.jsonl */
export function readEscalationsSync(coordDir: string): EscalationRequest[] {
	try {
		const filePath = path.join(coordDir, "escalations.jsonl");
		if (!fsSync.existsSync(filePath)) return [];
		const content = fsSync.readFileSync(filePath, "utf-8");
		const results: EscalationRequest[] = [];
		for (const line of content.trim().split("\n")) {
			if (!line.trim()) continue;
			try {
				results.push(JSON.parse(line) as EscalationRequest);
			} catch {
				// skip malformed
			}
		}
		return results;
	} catch {
		return [];
	}
}

/** Check if an escalation has been responded to */
export function hasEscalationResponse(coordDir: string, id: string): boolean {
	return fsSync.existsSync(path.join(coordDir, "escalation-responses", `${id}.json`));
}

/** Get pending escalations (no response yet, not timed out) */
export function getPendingEscalations(coordDir: string): EscalationRequest[] {
	const all = readEscalationsSync(coordDir);
	const now = Date.now();
	return all.filter((e) => {
		if (hasEscalationResponse(coordDir, e.id)) return false;
		// Still within timeout window
		const expiry = e.createdAt + e.timeout * 1000;
		return now < expiry;
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-proceed / deviation logging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log an auto-resolved escalation deviation to deviations.jsonl.
 * This records that the agent proceeded without user input.
 */
export function logAutoResolutionDeviation(
	coordDir: string,
	req: EscalationRequest,
	choice: string,
): void {
	try {
		const deviationsPath = path.join(coordDir, "deviations.jsonl");
		const deviation = {
			type: "auto_resolved_escalation",
			escalationId: req.id,
			question: req.question,
			chosenOption: choice,
			agentAssumption: req.agentAssumption,
			confidence: req.confidence,
			timestamp: Date.now(),
		};
		fsSync.appendFileSync(deviationsPath, JSON.stringify(deviation) + "\n");
	} catch {
		// best-effort
	}
}
