/**
 * Pega Infinity Authoring MCP bridge for pi.
 *
 * Spawns the bundled Pega MCP server (infinity-rules-mcp.jar) over stdio,
 * performs the MCP handshake, and registers its tools as native pi tools.
 * Connection settings come from ~/.infinity-rules-mcp/config.json
 * (pega_base_url, pega_oauth_client_id, pega_infinity_version), the same
 * config file the official Pega plugins use.
 *
 * Security model:
 * - READ-ONLY by default. Tools that modify Pega data (rules, cases,
 *   ChangeRequests) are not registered unless write access is explicitly
 *   enabled with PEGA_MCP_WRITE_TOOLS=1.
 * - The jar's SHA-256 is pinned. A mismatch refuses to start so a `git pull`
 *   of the Pega repo cannot silently swap the executable. Override with
 *   PEGA_MCP_EXPECTED_JAR_SHA256 or update the PINNED_JAR_SHA256 constant.
 *
 * Environment variables:
 * - PEGA_MCP_WRITE_TOOLS=1          register write tools (default: off)
 * - PEGA_MCP_EXPECTED_JAR_SHA256    override the pinned jar hash
 * - PEGA_MCP_TIMEOUT_MS             per-request timeout (default: 120000)
 * - PEGA_PLUGIN_DIR                 path to .../plugins/pega/infinity-ai-plugins/claude
 *
 * Prerequisites:
 * - Java 17+: brew install openjdk@17
 * - Repo clone at ~/.pi/agent/pega/infinity-ai-plugins (or set PEGA_PLUGIN_DIR).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = join(homedir(), ".infinity-rules-mcp", "config.json");

/** SHA-256 of the tested infinity-rules-mcp.jar at Pega repo commit 5b53502d. */
const PINNED_JAR_SHA256 = "1ff3c89608481d102304b2cec72757847fb5d906aa3df2c33bc18f33dc3dd4d2";

/** Tools that create or modify Pega data. Gated behind PEGA_MCP_WRITE_TOOLS=1. */
const WRITE_TOOLS = new Set([
	"create-case",
	"perform-action",
	"trigger-optional-process",
	"initiate-authoring-change",
	"copy-rule",
	"create-rule",
	"update-rule",
]);

const JAVA_CANDIDATES = [
	"/opt/homebrew/opt/openjdk@17/bin/java",
	"/opt/homebrew/bin/java",
	"java",
];

function resolvePluginDir(): string | null {
	const candidates: string[] = [];
	if (process.env.PEGA_PLUGIN_DIR) candidates.push(process.env.PEGA_PLUGIN_DIR);
	candidates.push(
		join(homedir(), ".pi", "agent", "pega", "infinity-ai-plugins", "plugins", "pega", "infinity-ai-plugins", "claude"),
	);
	for (const dir of candidates) {
		if (existsSync(join(dir, "resources", "infinity-rules-mcp.jar"))) return dir;
	}
	return null;
}

function requestTimeoutMs(): number {
	const parsed = Number.parseInt(process.env.PEGA_MCP_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

function writeToolsEnabled(): boolean {
	return ["1", "true", "yes", "on"].includes((process.env.PEGA_MCP_WRITE_TOOLS ?? "").toLowerCase());
}

// ---------------------------------------------------------------------------
// Bridge singleton.
//
// pi reloads and rebinds extensions on every session switch (/new, /resume,
// /fork). All mutable state therefore lives in one process-wide bridge object
// stored on globalThis, so rebinds reuse the running jar instead of spawning
// a new JVM per session.
// ---------------------------------------------------------------------------

interface JsonRpcError {
	code: number;
	message: string;
}

interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface Bridge {
	child: ChildProcessWithoutNullStreams | null;
	started: boolean;
	starting: Promise<boolean> | null;
	nextId: number;
	pending: Map<number, PendingRequest>;
	listedTools: McpToolDef[] | null;
	serverInfo: string;
	startError: string;
	exitHookInstalled: boolean;
}

const BRIDGE_KEY = "__pegaMcpBridge";

function getBridge(): Bridge {
	const holder = globalThis as Record<string, unknown>;
	if (!holder[BRIDGE_KEY]) {
		holder[BRIDGE_KEY] = {
			child: null,
			started: false,
			starting: null,
			nextId: 1,
			pending: new Map(),
			listedTools: null,
			serverInfo: "",
			startError: "",
			exitHookInstalled: false,
		} satisfies Bridge;
	}
	return holder[BRIDGE_KEY] as Bridge;
}

interface PegaConfig {
	pega_base_url?: string;
	pega_oauth_client_id?: string;
	pega_infinity_version?: string;
}

function loadConfig(): PegaConfig {
	const bridge = getBridge();
	try {
		if (existsSync(CONFIG_FILE)) {
			return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as PegaConfig;
		}
	} catch (e) {
		bridge.startError = `Invalid JSON in ${CONFIG_FILE}: ${(e as Error).message}`;
	}
	return {};
}

function configPermissionsWarning(): string | null {
	// Windows has no POSIX file modes; statSync().mode there is not meaningful
	// for this purpose and would warn spuriously.
	if (process.platform === "win32") return null;
	try {
		const mode = statSync(CONFIG_FILE).mode & 0o777;
		if (mode !== 0o600) {
			return `${CONFIG_FILE} is mode ${mode.toString(8)}; it should be 600 (chmod 600) since it gates access to your Pega environment.`;
		}
	} catch {
		// File missing: handled elsewhere.
	}
	return null;
}

function resolveJava(): string {
	for (const candidate of JAVA_CANDIDATES) {
		if (!candidate.includes("/") || existsSync(candidate)) return candidate;
	}
	return "java";
}

async function verifyJarHash(jarPath: string): Promise<string | null> {
	const expected = process.env.PEGA_MCP_EXPECTED_JAR_SHA256 || PINNED_JAR_SHA256;
	const actual = createHash("sha256").update(readFileSync(jarPath)).digest("hex");
	if (actual === expected) return null;
	return (
		`infinity-rules-mcp.jar hash mismatch.\n` +
		`expected: ${expected}\n` +
		`actual:   ${actual}\n` +
		`If you intentionally updated the Pega repo, set PEGA_MCP_EXPECTED_JAR_SHA256 to the ` +
		`actual hash, or update PINNED_JAR_SHA256 in the pega-mcp extension.`
	);
}

function send(bridge: Bridge, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
	if (!bridge.child) return Promise.reject(new Error("Pega MCP server is not running"));
	const child = bridge.child;
	const id = bridge.nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			bridge.pending.delete(id);
			reject(new Error(`Pega MCP: timeout waiting for ${method} after ${timeoutMs}ms`));
		}, timeoutMs);
		bridge.pending.set(id, { resolve, reject, timer });
		try {
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		} catch (e) {
			clearTimeout(timer);
			bridge.pending.delete(id);
			reject(e as Error);
		}
	});
}

function rejectAllPending(bridge: Bridge, error: Error) {
	for (const [, p] of bridge.pending) {
		clearTimeout(p.timer);
		p.reject(error);
	}
	bridge.pending.clear();
}

function stopServer(bridge: Bridge) {
	if (bridge.child) {
		try {
			bridge.child.kill();
		} catch {
			// already gone
		}
		bridge.child = null;
	}
	bridge.started = false;
	rejectAllPending(bridge, new Error("Pega MCP server stopped"));
}

function wireChildHandlers(bridge: Bridge, child: ChildProcessWithoutNullStreams) {
	// Without these, a failed spawn (missing java) or a dead-pipe write (jar
	// killed mid-session) emits an 'error' event with no listener, which throws
	// as an uncaught exception and takes pi down.
	const onError = (err: Error) => {
		bridge.startError = (bridge.startError ? bridge.startError + "\n" : "") + err.message;
		bridge.started = false;
		if (bridge.child === child) bridge.child = null;
		rejectAllPending(bridge, new Error(`Pega MCP server error: ${err.message}`));
	};
	child.on("error", onError);
	child.stdin.on("error", onError);
	child.stdout.on("error", onError);
	child.stderr.on("error", onError);

	child.stderr.on("data", (d: Buffer) => {
		const text = d.toString().trim();
		if (text && bridge.startError.length < 8000) {
			bridge.startError += (bridge.startError ? "\n" : "") + text;
		}
	});

	child.on("exit", (code) => {
		bridge.started = false;
		if (bridge.child === child) bridge.child = null;
		rejectAllPending(bridge, new Error(`Pega MCP server exited (code ${code ?? "signal"})`));
	});

	// Keep pi's event loop free so pi -p mode and quiet TUI exits do not hang
	// waiting for the jar's pipes. The process exit hook kills the jar.
	child.unref();
	child.stdin.unref();
	child.stdout.unref();
	child.stderr.unref();

	if (!bridge.exitHookInstalled) {
		bridge.exitHookInstalled = true;
		process.on("exit", () => stopServer(getBridge()));
	}
}

function wireMessageHandler(bridge: Bridge, child: ChildProcessWithoutNullStreams) {
	const rl = createInterface({ input: child.stdout });
	rl.on("line", (line) => {
		line = line.trim();
		if (!line) return;
		let msg: { id?: number | string; error?: JsonRpcError; result?: unknown };
		try {
			msg = JSON.parse(line);
		} catch {
			return; // Startup banner or non-JSON noise on stdout.
		}
		if (msg.id !== undefined && bridge.pending.has(msg.id)) {
			const p = bridge.pending.get(msg.id)!;
			bridge.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new Error(`Pega MCP ${msg.error.code}: ${msg.error.message}`));
			else p.resolve(msg.result);
		}
		// Notifications (logging, progress) are ignored.
	});
}

async function startServer(bridge: Bridge): Promise<boolean> {
	const pluginDir = resolvePluginDir();
	if (!pluginDir) {
		bridge.startError = "infinity-rules-mcp.jar not found";
		return false;
	}

	const jarPath = join(pluginDir, "resources", "infinity-rules-mcp.jar");
	const hashError = await verifyJarHash(jarPath);
	if (hashError) {
		bridge.startError = hashError;
		return false;
	}

	const config = loadConfig();
	const child = spawn(resolveJava(), ["-jar", jarPath, "--spring.profiles.active=stdio"], {
		cwd: pluginDir,
		env: {
			...process.env,
			PEGA_SKILLS_PATH: join(pluginDir, "resources"),
			PEGA_CLIENT_MODE: "pi-extension",
			PEGA_BASE_URL: config.pega_base_url ?? "",
			PEGA_OAUTH_CLIENT_ID: config.pega_oauth_client_id ?? "",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	bridge.child = child;
	wireChildHandlers(bridge, child);
	wireMessageHandler(bridge, child);

	try {
		const init = (await send(bridge, "initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "pi-pega-bridge", version: "0.2.0" },
		}, 30_000)) as { serverInfo?: { name?: string; version?: string } } | undefined;
		bridge.serverInfo = init?.serverInfo ? `${init.serverInfo.name} ${init.serverInfo.version}` : "unknown";
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
		bridge.started = true;
		return true;
	} catch (e) {
		bridge.startError = (bridge.startError ? bridge.startError + "\n" : "") + `MCP handshake failed: ${(e as Error).message}`;
		stopServer(bridge);
		return false;
	}
}

/** Idempotent start: reuses the running jar, coalesces concurrent starts. */
function ensureStarted(bridge: Bridge): Promise<boolean> {
	if (bridge.started && bridge.child) return Promise.resolve(true);
	if (bridge.starting) return bridge.starting;
	bridge.startError = "";
	bridge.starting = startServer(bridge).finally(() => {
		bridge.starting = null;
	});
	return bridge.starting;
}

async function listTools(bridge: Bridge): Promise<McpToolDef[]> {
	if (bridge.listedTools) return bridge.listedTools;
	const result = (await send(bridge, "tools/list", {}, 30_000)) as { tools?: McpToolDef[] } | undefined;
	bridge.listedTools = result?.tools ?? [];
	return bridge.listedTools;
}

function statusLines(bridge: Bridge): string[] {
	const config = loadConfig();
	const mode = writeToolsEnabled() ? "read+write" : "read-only";
	const lines = [
		`server: ${bridge.started && bridge.child ? "running" : "stopped"} (${bridge.serverInfo})`,
		`mode: ${mode}`,
		`tools registered: ${bridge.listedTools?.length ?? 0}`,
		`base url: ${config.pega_base_url || "(not configured)"}`,
		`version: ${config.pega_infinity_version || "26-1 (default)"}`,
		`config: ${existsSync(CONFIG_FILE) ? CONFIG_FILE : "(missing)"}`,
	];
	const permWarning = configPermissionsWarning();
	if (permWarning) lines.push(`warning: ${permWarning}`);
	if (bridge.startError) lines.push(`last error: ${bridge.startError.split("\n")[0].slice(0, 200)}`);
	return lines;
}

export default async function pegaMcpExtension(pi: ExtensionAPI) {
	const bridge = getBridge();

	if (!resolvePluginDir()) {
		pi.on("session_start", (_e, ctx) => {
			ctx.ui.notify(
				"pega-mcp: jar not found. Clone infinity-ai-plugins into ~/.pi/agent/pega/ or set PEGA_PLUGIN_DIR.",
				"error",
			);
		});
		return;
	}

	const ok = await ensureStarted(bridge);
	if (!ok) {
		const hint = /UnsupportedClassVersionError|class file version/i.test(bridge.startError)
			? "Pega's MCP server requires Java 17 or later. "
			: "";
		pi.on("session_start", (_e, ctx) => {
			ctx.ui.notify(`pega-mcp: server failed to start. ${hint}${bridge.startError.slice(0, 400)}`, "error");
		});
		return;
	}

	let tools: McpToolDef[];
	try {
		tools = await listTools(bridge);
	} catch (e) {
		pi.on("session_start", (_e, ctx) => {
			ctx.ui.notify(`pega-mcp: failed to list tools: ${(e as Error).message}`, "error");
		});
		return;
	}

	const writeEnabled = writeToolsEnabled();
	const skipped: string[] = [];

	for (const tool of tools) {
		if (WRITE_TOOLS.has(tool.name) && !writeEnabled) {
			skipped.push(tool.name);
			continue;
		}
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description ?? `Pega authoring tool: ${tool.name}`,
			// MCP inputSchema is standard JSON Schema; typebox schemas are JSON Schema.
			parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
			async execute(_toolCallId, params, _signal) {
				// The jar has no cancellation endpoint; an aborted tool call is
				// allowed to finish server-side and its result is discarded.
				try {
					const res = (await send(bridge, "tools/call", {
						name: tool.name,
						arguments: params ?? {},
					}, requestTimeoutMs())) as
						| { content?: Array<{ type: string; text?: string }>; isError?: boolean }
						| undefined;
					const content: Array<{ type: "text"; text: string }> = [];
					for (const part of res?.content ?? []) {
						if (part.type === "text" && typeof part.text === "string") {
							content.push({ type: "text", text: part.text });
						} else {
							content.push({ type: "text", text: `[unsupported ${part.type} content from Pega MCP]` });
						}
					}
					if (content.length === 0) content.push({ type: "text", text: "(empty response)" });
					return {
						content,
						details: { tool: tool.name, isError: !!res?.isError },
						isError: !!res?.isError,
					};
				} catch (e) {
					return {
						content: [{ type: "text", text: `Pega MCP error: ${(e as Error).message}` }],
						details: { tool: tool.name, isError: true },
						isError: true,
					};
				}
			},
		});
	}

	pi.registerCommand("pega-status", {
		description: "Show Pega MCP bridge status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(statusLines(bridge).join("\n"), bridge.started ? "info" : "warning");
			if (skipped.length > 0 && !writeEnabled) {
				ctx.ui.notify(`write tools disabled: ${skipped.join(", ")}`, "info");
			}
		},
	});

	pi.registerCommand("pega-restart", {
		description: "Restart the Pega MCP server (picks up config.json changes)",
		handler: async (_args, ctx) => {
			stopServer(bridge);
			bridge.listedTools = null;
			const restarted = await ensureStarted(bridge);
			ctx.ui.notify(
				restarted ? "pega-mcp: restarted" : `pega-mcp: restart failed. ${bridge.startError.slice(0, 300)}`,
				restarted ? "info" : "error",
			);
		},
	});

	pi.on("session_start", (_e, ctx) => {
		const config = loadConfig();
		const mode = writeEnabled ? "read+write" : "read-only";
		const configured = !!config.pega_base_url;
		const permWarning = configPermissionsWarning();
		let message = configured
			? `pega-mcp: ${tools.length - skipped.length} Pega tools registered (${mode})`
			: `pega-mcp: ${tools.length - skipped.length} tools registered (${mode}), but no Pega connection configured. Create ~/.infinity-rules-mcp/config.json with pega_base_url.`;
		if (!configured) message += " Run /pega-status for details.";
		if (permWarning) message += ` ${permWarning}`;
		ctx.ui.notify(message, configured && !permWarning ? "info" : "warning");
	});
}
