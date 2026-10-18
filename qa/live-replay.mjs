// Isolated live replay of the omo-tips-translate extension in the bundled Senpi
// engine CLI. Every scenario gets its own temporary agent dir (all
// brandEnvNames("CODING_AGENT_DIR") variants), a 150x45 PTY, and no prompt typed
// unless the working tip needs a turn. Nothing touches the user's real agent dir.
//
// Scenarios:
//   E  baseline without the tips extension: capture English startup/working tips and key values
//   A  translated startup tip, pointer, reasoning notice, and working tip
//   B  first run: model select, language select, background progress, store creation
//   C  changed sourceHash: one re-translate confirmation
//   D  corrupt store: English fallback, no TypeError
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/[\\/]$/, "");
const SENPI_DIST =
	process.env.SENPI_DIST ?? "C:/Users/yjack/.omo/agent/runtime/0b0c6ca88f3a3632-7e186e28b781/dist";
const CLI = join(SENPI_DIST, "bundle/cli.js");
const COLS = 150;
const ROWS = 45;
const EVIDENCE = join(REPO, ".omo/evidence");
const TMP = process.env.TMPDIR ?? tmpdir();
const ROOT = mkdtempSync(join(TMP, "tips-translate-live-"));
const XTERM = join(ROOT, "xterm");

if (!existsSync(CLI)) throw new Error(`senpi bundle CLI not found at ${CLI}; set SENPI_DIST`);

const { loadTemplates, sourceHash, POINTER_EN } = await import(pathToFileURL(join(REPO, "src/extract.ts")).href);
const { TIP_DEFINITIONS } = await import(
	pathToFileURL(join(SENPI_DIST, "modes/interactive/tips/registry.js")).href
);
const { brandEnvNames } = await import(pathToFileURL(join(SENPI_DIST, "core/brand.js")).href);

const RUNTIME_ROOT = dirname(SENPI_DIST);
const loaded = loadTemplates(RUNTIME_ROOT);
const templates = loaded.templates;
const HASH = sourceHash(templates);
const TIP_IDS = new Set(TIP_DEFINITIONS.map((tip) => tip.id));
for (const template of templates) TIP_IDS.add(template.id);
const STARTUP_TIP = "queue-follow-up";
const WORKING_TIP = "steering-message";
const REASONING_TIP = "reasoning-level-key";
const UNSEEN = new Set([STARTUP_TIP, WORKING_TIP, REASONING_TIP]);
const OLD = 1;

const translations = {
	[STARTUP_TIP]: "번역: 작업 중에는 {0} 키로 후속 메시지를 예약할 수 있습니다.",
	[WORKING_TIP]:
		"번역: {0}를 누르면 현재 도구 묶음 뒤에 작업을 조정하고, {1}은 모든 작업이 끝날 때까지 기다립니다.",
};
const POINTER_KO = "번역: 모든 팁의 전체 이야기가 궁금하면 give-me-tips 스킬에 물어보세요.";

function makeTable() {
	const entries = {};
	for (const template of templates) {
		entries[template.id] = {
			en: template.en,
			tr: translations[template.id] ?? `번역: ${template.en}`,
		};
	}
	return { prefix: "번역: ", pointer: POINTER_KO, entries };
}

function makeStore(overrides = {}) {
	return {
		version: 1,
		omoVersion: "qa",
		sourceHash: HASH,
		model: { provider: "fake-translator", id: "fake-translator-1" },
		language: "한국어",
		enabled: true,
		table: makeTable(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function history() {
	const out = {};
	for (const id of TIP_IDS) if (!UNSEEN.has(id)) out[id] = OLD;
	return out;
}

const agentEnv = Object.fromEntries(brandEnvNames("CODING_AGENT_DIR").map((name) => [name, null]));
function envFor(agent) {
	const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
	for (const name of Object.keys(agentEnv)) env[name] = agent;
	for (const legacy of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
		env[legacy] = agent;
	}
	return env;
}

function prepareAgent(name, { store } = {}) {
	const agent = join(ROOT, name, "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(
		join(agent, "settings.json"),
		JSON.stringify(
			{
				tips: true,
				quietStartup: false,
				defaultProvider: "fake-translator",
				defaultModel: "fake-translator-1",
				packages: [],
				disabledBuiltinExtensions: ["codemode"],
				tipsHistory: history(),
			},
			null,
			2,
		),
	);
	if (store !== undefined) {
		writeFileSync(
			join(agent, "omo-tips-translate.json"),
			typeof store === "string" ? store : JSON.stringify(store, null, 2),
		);
	}
	return agent;
}

const scenarios = [];
const ptyReceipts = [];

async function run(name, options) {
	const agent = prepareAgent(name, options);
	const argv = [
		process.execPath,
		CLI,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-approve",
		"--offline",
		"-e",
		join(REPO, "qa/fake-translator.ts"),
	];
	if (options.tips) argv.push("-e", join(REPO, "extension/tips-translate.ts"));

	const chunks = [];
	let total = 0;
	const waiters = new Set();
	const proc = Bun.spawn(argv, {
		cwd: REPO,
		env: envFor(agent),
		terminal: {
			cols: COLS,
			rows: ROWS,
			data(_terminal, data) {
				chunks.push(Buffer.from(data));
				total += data.length;
				for (const waiter of waiters) waiter();
			},
		},
	});
	const raw = () => Buffer.concat(chunks);
	const plain = () => Bun.stripANSI(raw().toString("utf8"));

	// Character offsets refer to the ANSI-stripped stream; byte offsets are used
	// only for xterm snapshots.
	const waitFor = (from, pattern, maxMs = 30000) =>
		new Promise((resolve, reject) => {
			const deadline = setTimeout(() => {
				waiters.delete(check);
				reject(new Error(`${name}: no ${pattern} within ${maxMs}ms after char ${from}`));
			}, maxMs);
			const check = () => {
				if (!pattern.test(plain().slice(from))) return;
				clearTimeout(deadline);
				waiters.delete(check);
				resolve(plain().length);
			};
			waiters.add(check);
			check();
		});

	const waitIdle = (from, quietMs = 900, maxMs = 20000) =>
		new Promise((resolve, reject) => {
			let quiet;
			const deadline = setTimeout(() => done(new Error(`${name}: no idle within ${maxMs}ms`)), maxMs);
			const arm = () => {
				clearTimeout(quiet);
				if (total > from) quiet = setTimeout(() => done(), quietMs);
			};
			const done = (error) => {
				clearTimeout(deadline);
				clearTimeout(quiet);
				waiters.delete(arm);
				error ? reject(error) : resolve(total);
			};
			waiters.add(arm);
			if (total > from) arm();
		});

	const send = (text) => {
		const from = plain().length;
		proc.terminal.write(text);
		return from;
	};

	let killed = false;
	const kill = async () => {
		if (killed) return;
		killed = true;
		if (process.platform === "win32") await Bun.$`taskkill /PID ${proc.pid} /T /F`.nothrow().quiet();
		else proc.kill("SIGKILL");
		await proc.exited;
		ptyReceipts.push({ scenario: name, pid: proc.pid, exitCode: proc.exitCode, killed, exited: proc.exitCode !== null });
	};

	const marks = new Map();
	const mark = async (label, quietMs = 900) => {
		// Some TUI states keep repainting (cursor/spinner); a settled frame is nice
		// but not required for the snapshot, so fall back to the current byte mark.
		await waitIdle(total, quietMs, 5000).catch(() => undefined);
		const end = total;
		marks.set(label, end);
		return end;
	};

	return { name, agent, argv, proc, total: () => total, raw, plain, waitFor, waitIdle, send, kill, marks, mark };
}

const waitForStore = async (path, maxMs = 60000) => {
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	return false;
};

const results = [];

function check(name, label, ok, detail = "") {
	results.push({ scenario: name, label, ok: Boolean(ok), detail });
}

// Scenario E: baseline without the tips extension.
const baseline = await run("E", { tips: false });
let baselineScreen = "";
let english = {};
try {
	await baseline.waitFor(0, /Tip: While the agent is working, use .+ to queue a follow-up/, 90000);
	await baseline.mark("startup", 1200);
	const startupScreen = baseline.plain();
	english.queue = startupScreen.match(/Tip: While the agent is working, use (.+?) to queue a follow-up/)?.[1] ?? "";
	english.reasoning = startupScreen.match(/Tip: (.+?) changes the reasoning level/)?.[1] ?? "";
	const sent = baseline.send("hello\r");
	await baseline.waitFor(sent, /Tip: Press .+ while the agent works to steer/, 30000);
	baselineScreen = await baseline.mark("working", 1200);
	english.workingScreen = baseline.plain().slice(sent);
	english.steer = english.workingScreen.match(/Tip: Press (.+?) while the agent works/)?.[1] ?? "";
	english.waits = english.workingScreen.match(/; (.+?) waits until all work is done/)?.[1] ?? "";
	check("E", "English startup tip captured", Boolean(english.queue));
	check("E", "English working tip captured", /Tip: Press .+ while the agent works/.test(english.workingScreen));
	check("E", "English reasoning notice captured", Boolean(english.reasoning));
} finally {
	await baseline.kill();
}
scenarios.push({ ...baseline, baselineScreen, english });

// Scenario A: translated startup, reasoning, pointer, and working tips.
const scenarioA = await run("A", { tips: true, store: makeStore() });
try {
	await scenarioA.waitFor(0, /번역: .*후속 메시지/, 90000);
	await scenarioA.waitFor(0, /번역: .+ changes the reasoning level/, 30000);
	await scenarioA.mark("startup", 1200);
	// The first frame can draw English before session_start installs the saved
	// matcher; assert on the translated frame that follows it.
	const startupText = scenarioA.plain().slice(scenarioA.plain().indexOf("번역: "));
	const sent = scenarioA.send("hello\r");
	await scenarioA.waitFor(sent, /번역: .*작업을 조정/, 30000);
	await scenarioA.mark("working", 1200);
	const workingText = scenarioA.plain().slice(sent);
	check("A", "startup tip contains 번역:", startupText.includes("번역:"));
	check("A", "startup tip has no 'Want the full story'", !startupText.includes("Want the full story"));
	check("A", "startup tip has no English queue wording", !startupText.includes("to queue a follow-up"));
	check("A", "reasoning notice is translated", /번역: .+ changes the reasoning level/.test(startupText));
	check("A", "startup shortcut matches baseline", Boolean(english.queue) && startupText.includes(english.queue));
	check("A", "reasoning shortcut matches baseline", Boolean(english.reasoning) && startupText.includes(english.reasoning));
	check("A", "working tip is translated", /번역: .*작업을 조정/.test(workingText));
	check("A", "working shortcuts match baseline", [english.steer, english.waits].every((key) => key && workingText.includes(key)));
} catch (error) {
	console.error("A PLAIN TAIL\n" + scenarioA.plain().slice(-12000));
	throw error;
} finally {
	await scenarioA.kill();
}
scenarios.push({ ...scenarioA });

// Scenario B: first run, driven through model and language selects.
const scenarioB = await run("B", { tips: true });
const storeB = join(scenarioB.agent, "omo-tips-translate.json");
let storeDataB;
try {
	const modelAt = await scenarioB.waitFor(0, /번역에 사용할 모델을 고르세요/, 90000);
	await scenarioB.mark("model-select", 700);
	scenarioB.send("\r");
	const languageAt = await scenarioB.waitFor(modelAt, /팁을 표시할 언어를 고르세요/, 30000);
	await scenarioB.mark("language-select", 700);
	const selectedAt = scenarioB.send("\r");
	await scenarioB.waitFor(selectedAt, /🌐 팁/, 30000);
	await scenarioB.waitFor(selectedAt, /번역했습니다/, 60000);
	const found = await waitForStore(storeB, 60000);
	await scenarioB.mark("done", 1500);
	const text = scenarioB.plain().slice(languageAt);
	storeDataB = found ? JSON.parse(readFileSync(storeB, "utf8")) : undefined;
	check("B", "model select dialog shown", /번역에 사용할 모델을 고르세요/.test(scenarioB.plain()));
	check("B", "language select dialog shown", /팁을 표시할 언어를 고르세요/.test(scenarioB.plain()));
	check("B", "status line showed 🌐 팁", text.includes("🌐 팁"));
	check("B", "translation completion notice shown", text.includes("번역했습니다"));
	check("B", "store file created", found);
	check("B", "store model is fake provider", storeDataB?.model?.provider === "fake-translator" && storeDataB?.model?.id === "fake-translator-1");
	check("B", "store language is 한국어", storeDataB?.language === "한국어");
	check("B", "store omoVersion recorded", typeof storeDataB?.omoVersion === "string" && storeDataB.omoVersion.length > 0);
} finally {
	await scenarioB.kill();
}
scenarios.push({ ...scenarioB });

// Scenario C: stale sourceHash asks once.
const scenarioC = await run("C", { tips: true, store: makeStore({ sourceHash: "stale-hash" }) });
try {
	await scenarioC.waitFor(0, /omo 업데이트로 팁이 바뀌었습니다\. 새 팁을 번역할까요\?/, 90000);
	await scenarioC.mark("confirm", 900);
	const text = scenarioC.plain();
	check("C", "re-translate confirmation shown", text.includes("omo 업데이트로 팁이 바뀌었습니다. 새 팁을 번역할까요?"));
	check("C", "confirmation title shown", text.includes("팁이 바뀌었습니다"));
} finally {
	await scenarioC.kill();
}
scenarios.push({ ...scenarioC });

// Scenario D: corrupt store falls back to English.
const scenarioD = await run("D", { tips: true, store: "{ this is not json" });
try {
	await scenarioD.waitFor(0, /저장된 번역을 읽지 못했습니다/, 90000);
	await scenarioD.mark("corrupt", 1200);
	const text = scenarioD.plain();
	check("D", "corrupt-store warning shown", text.includes("저장된 번역을 읽지 못했습니다"));
	check("D", "startup tip stays English", /Tip: While the agent is working, use .+ to queue a follow-up/.test(text));
	check("D", "English pointer stays", text.includes("Want the full story"));
	check("D", "no TypeError", !scenarioD.plain().includes("TypeError"));
	check("D", "no translation notice", !text.includes("번역했습니다"));
} finally {
	await scenarioD.kill();
}
scenarios.push({ ...scenarioD });

// Render each captured mark through xterm.js, then save screen text and raw output.
mkdirSync(EVIDENCE, { recursive: true });
mkdirSync(XTERM, { recursive: true });
if (!existsSync(join(XTERM, "node_modules/@xterm/xterm/lib/xterm.js"))) {
	writeFileSync(join(XTERM, "package.json"), JSON.stringify({ name: "qa-xterm", private: true }));
	const add = await Bun.$`bun add @xterm/xterm`.cwd(XTERM).nothrow().quiet();
	if (add.exitCode !== 0) throw new Error(`bun add @xterm/xterm failed: ${add.stderr.toString()}`);
}
const xjs = await Bun.file(join(XTERM, "node_modules/@xterm/xterm/lib/xterm.js")).text();
const xcss = await Bun.file(join(XTERM, "node_modules/@xterm/xterm/css/xterm.css")).text();
const page = join(ROOT, "page.html");
writeFileSync(
	page,
	`<!doctype html><html><head><meta charset="utf-8"><style>${xcss}html,body{margin:0;background:#fff}</style>
<script>${xjs.replace(/<\/script/g, "<\\/script")}</script></head><body><div id="t"></div><script>
window.show = (b64) => new Promise((resolve) => {
  document.getElementById("t").innerHTML = "";
  const term = new Terminal({ cols: ${COLS}, rows: ${ROWS}, fontSize: 13, theme: { background: "#ffffff", foreground: "#1f2328", cursor: "#1f2328" }, fontFamily: "Consolas, monospace", allowProposedApi: true, scrollback: 100000 });
  term.open(document.getElementById("t"));
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  term.write(bytes, () => requestAnimationFrame(() => {
    const buf = term.buffer.active;
    const lines = [];
    for (let i = buf.viewportY; i < buf.viewportY + ${ROWS}; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    resolve(lines.join("\\n"));
  }));
});
</script></body></html>`,
);
const view = new Bun.WebView({ width: 1200, height: 800 });
const evidenceFiles = [];
try {
	await view.navigate(`file:///${page.replace(/\\/g, "/")}`);
	for (const scenario of scenarios) {
		const stream = scenario.raw();
		writeFileSync(join(EVIDENCE, `live-${scenario.name}-raw.ansi`), stream);
		evidenceFiles.push(join(EVIDENCE, `live-${scenario.name}-raw.ansi`));
		for (const [label, end] of scenario.marks) {
			const screen = await view.evaluate(
				`window.show(${JSON.stringify(stream.subarray(0, end).toString("base64"))})`,
			);
			const textPath = join(EVIDENCE, `live-${scenario.name}-${label}.txt`);
			writeFileSync(textPath, screen);
			evidenceFiles.push(textPath);
			await Bun.write(join(EVIDENCE, `live-${scenario.name}-${label}.png`), await view.screenshot());
		}
	}
} finally {
	view.close?.();
}

if (storeDataB) {
	writeFileSync(join(EVIDENCE, "live-B-store.json"), JSON.stringify(storeDataB, null, 2));
	evidenceFiles.push(join(EVIDENCE, "live-B-store.json"));
}

// Cleanup and receipts.
rmSync(ROOT, { recursive: true, force: true });
const receipt = {
	cleanup: { path: ROOT, exists: existsSync(ROOT) },
	pty: ptyReceipts,
	evidence: evidenceFiles,
	english,
	baselineScreen,
	storeB: storeDataB
		? { omoVersion: storeDataB.omoVersion, model: storeDataB.model, language: storeDataB.language, entries: Object.keys(storeDataB.table.entries).length }
		: undefined,
	results,
};
writeFileSync(join(EVIDENCE, "live-replay-receipt.json"), JSON.stringify(receipt, null, 2));
console.log(`cleanup: ${ROOT} exists=${existsSync(ROOT)}`);
for (const pty of ptyReceipts) {
	console.log(`pty: ${pty.scenario} pid=${pty.pid} exitCode=${pty.exitCode} killed=${pty.killed} exited=${pty.exited}`);
}
if (storeDataB) {
	console.log(
		`store B: omoVersion=${storeDataB.omoVersion} model=${storeDataB.model.provider}/${storeDataB.model.id} language=${storeDataB.language}`,
	);
}

const byScenario = new Map();
for (const result of results) {
	if (!byScenario.has(result.scenario)) byScenario.set(result.scenario, []);
	byScenario.get(result.scenario).push(result);
}
let failed = 0;
for (const name of ["E", "A", "B", "C", "D"]) {
	const checks = byScenario.get(name) ?? [{ label: "scenario ran", ok: false }];
	const bad = checks.filter((check) => !check.ok);
	if (bad.length > 0) failed++;
	console.log(`${bad.length === 0 ? "PASS" : "FAIL"} ${name}: ${checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.label}`).join(" | ")}`);
	for (const check of bad) if (check.detail) console.log(`  ${check.detail}`);
}
console.log(`evidence: ${EVIDENCE}`);
process.exit(failed === 0 ? 0 : 1);
