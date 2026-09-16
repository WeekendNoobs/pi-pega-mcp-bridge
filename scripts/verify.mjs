// Verify: connect to the configured Pega environment and list applications.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const JAR = process.env.HOME + "/.pi/agent/pega/infinity-ai-plugins/plugins/pega/infinity-ai-plugins/claude/resources/infinity-rules-mcp.jar";
const RES = process.env.HOME + "/.pi/agent/pega/infinity-ai-plugins/plugins/pega/infinity-ai-plugins/claude/resources";

const child = spawn("java", ["-jar", JAR, "--spring.profiles.active=stdio"], {
	env: { ...process.env, PEGA_SKILLS_PATH: RES, PEGA_CLIENT_MODE: "pi-verify" },
	stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

const pending = new Map();
let nextId = 1;
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
	line = line.trim();
	if (!line) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.id !== undefined && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	}
});

function request(method, params, timeoutMs = 280_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
		pending.set(id, (v) => { clearTimeout(t); resolve(v); });
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});
}

try {
	const init = await request("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "pi-verify", version: "0.1.0" },
	}, 30_000);
	console.log("INIT ok:", init.result?.serverInfo?.name);
	child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

	const r = await request("tools/call", { name: "list-available-applications", arguments: {} });
	const text = (r.result?.content ?? []).map((c) => c.text).join("\n");
	console.log("RESULT:", text.slice(0, 1500));
	if (r.result?.isError) console.log("(tool reported error)");
} catch (e) {
	console.log("ERROR:", e.message);
} finally {
	// Print anything OAuth-related from stderr to help debugging.
	const oauthLines = stderr.split("\n").filter((l) => /oauth|authorize|callback|localhost:8888|error|exception/i.test(l));
	console.log("--- stderr (oauth/error lines) ---");
	console.log(oauthLines.slice(-12).join("\n"));
	child.kill();
	process.exit(0);
}
