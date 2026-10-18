import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { POINTER_EN, PREFIX_EN, extractTemplates, sourceHash } from "../src/extract";
import { readStore, storePath, writeStore, type StoreData } from "../src/store";

const IMPL = Symbol.for("omo.tips-translate.impl.v1");
const HOOK = Symbol.for("omo.tips-translate.text-hook.v1");
const shared = globalThis as Record<PropertyKey, unknown>;

const CATALOG = [
	"const _TIPS=[",
	'{id:"hello",render:()=>`Hello world`},',
	'{id:"key",render:()=>`Press ${here()} now`},',
	"];",
].join("\n");

const templates = extractTemplates(CATALOG);
const catalogHash = sourceHash(templates);

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tips-translate-ext-"));
	tempDirs.push(dir);
	return dir;
}

function runtimeRoot(source = CATALOG): string {
	const root = tempDir();
	const chunks = join(root, "dist", "bundle", "chunks");
	mkdirSync(chunks, { recursive: true });
	writeFileSync(join(chunks, "tips.js"), source, "utf8");
	return root;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	shared[IMPL] = undefined;
});

type Model = { provider: string; id: string };

class FakeText {
	text: string;
	setTextCalls = 0;
	constructor(text = "") {
		this.text = text;
	}
	setText(text: string): void {
		this.setTextCalls++;
		this.text = text;
	}
	render(width: number): string[] {
		return [this.text.slice(0, width)];
	}
}

type Waiter = { pattern: RegExp; resolve: (message: string) => void; timer: ReturnType<typeof setTimeout> };

class FakeUi {
	selects: string[] = [];
	confirms: string[] = [];
	inputs: string[] = [];
	notices: Array<{ message: string; level?: string }> = [];
	statuses: Array<string | undefined> = [];
	renders = 0;
	selectQueue: Array<string | undefined> = [];
	confirmQueue: Array<boolean | undefined> = [];
	inputQueue: Array<string | undefined> = [];
	waiters: Waiter[] = [];

	select(title: string, options: string[]): Promise<string | undefined> {
		this.selects.push(`${title} :: ${options.join("|")}`);
		return Promise.resolve(this.selectQueue.shift());
	}

	confirm(title: string): Promise<boolean> {
		this.confirms.push(title);
		return Promise.resolve(this.confirmQueue.shift() ?? false);
	}

	input(title: string): Promise<string | undefined> {
		this.inputs.push(title);
		return Promise.resolve(this.inputQueue.shift());
	}

	notify(message: string, level?: string): void {
		this.notices.push({ message, level });
		for (const waiter of [...this.waiters]) {
			if (waiter.pattern.test(message)) {
				clearTimeout(waiter.timer);
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				waiter.resolve(message);
			}
		}
	}

	setStatus(_key: string, text: string | undefined): void {
		this.statuses.push(text);
	}

	requestRender(): void {
		this.renders++;
	}

	waitFor(pattern: RegExp, timeoutMs = 3000): Promise<string> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
				reject(new Error(`timed out waiting for ${pattern}`));
			}, timeoutMs);
			this.waiters.push({ pattern, resolve, timer });
		});
	}
}

type Complete = (system: string, user: string) => Promise<string>;

function translatedJson(system: string, user: string): string {
	const language = /translate into (.*?);/.exec(system)?.[1] ?? "TR";
	const items = JSON.parse(user) as Record<string, string>;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(items)) out[key] = `«${language}» ${value}`;
	return JSON.stringify(out);
}

function makeRegistry(options: { complete?: Complete; available?: Model[] } = {}) {
	const available = options.available ?? [
		{ provider: "fake", id: "translator" },
		{ provider: "fake", id: "other" },
	];
	const calls: Array<{ system: string; user: string }> = [];
	const complete = options.complete ?? (async (system, user) => translatedJson(system, user));
	return {
		calls,
		registry: {
			getAvailable: () => available,
			find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: () => true,
			complete: async (model: Model, context: { systemPrompt?: string; messages: unknown[] }) => {
				const message = context.messages[0] as { content: Array<{ text: string }> };
				const system = context.systemPrompt ?? "";
				const user = message.content[0]!.text;
				calls.push({ system, user });
				const text = await complete(system, user);
				return { content: [{ type: "text", text }], stopReason: "stop", model };
			},
		},
	};
}

function makeStore(options: {
	agentDir: string;
	language?: string;
	model?: Model;
	source?: string;
	entries?: Record<string, { en: string; tr: string }>;
	enabled?: boolean;
	declinedHash?: string;
}): StoreData {
	const model = options.model ?? { provider: "fake", id: "translator" };
	const data: StoreData = {
		version: 1,
		omoVersion: "9.9.9",
		sourceHash: options.source ?? sourceHash(templates),
		model,
		language: options.language ?? "한국어",
		enabled: options.enabled ?? true,
		...(options.declinedHash !== undefined ? { declinedHash: options.declinedHash } : {}),
		table: {
			prefix: `«${options.language ?? "한국어"}» ${PREFIX_EN}`,
			pointer: `«${options.language ?? "한국어"}» ${POINTER_EN}`,
			entries: options.entries ?? {
				hello: { en: "Hello world", tr: `«${options.language ?? "한국어"}» Hello world` },
				key: { en: "Press {0} now", tr: `«${options.language ?? "한국어"}» Press {0} now` },
			},
		},
		updatedAt: "2026-10-18T00:00:00.000Z",
	};
	writeStore(storePath(options.agentDir), data);
	return data;
}

type HostOptions = {
	text?: typeof FakeText | undefined;
	root?: string;
	agentDir?: string;
	ui?: FakeUi;
	registry?: ReturnType<typeof makeRegistry>["registry"];
	model?: Model;
	version?: string;
	withPackageDir?: boolean;
	withAgentDir?: boolean;
	withText?: boolean;
};

function makeHost(options: HostOptions = {}) {
	const ui = options.ui ?? new FakeUi();
	const agentDir = options.agentDir ?? tempDir();
	const root = options.root ?? runtimeRoot();
	const model = options.model ?? { provider: "fake", id: "original" };
	const registry = options.registry ?? makeRegistry().registry;
	const senpi: Record<string, unknown> = {
		VERSION: options.version ?? "9.9.9",
		getPackageDir: options.withPackageDir === false ? undefined : () => root,
		getAgentDir: options.withAgentDir === false ? undefined : () => agentDir,
	};
	return {
		Text: options.withText === false ? undefined : (options.text ?? FakeText),
		ui,
		agentDir,
		root,
		model,
		registry,
		senpi,
		ctx: { mode: "tui", agentDir, model, modelRegistry: registry, ui },
	};
}

let caseId = 0;

async function load(host: ReturnType<typeof makeHost>, tuiOverride?: Record<string, unknown>) {
	mock.module("@earendil-works/pi-tui", () => tuiOverride ?? { Text: host.Text });
	mock.module("@code-yeongyu/senpi", () => host.senpi);
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => unknown }) {
			commands.set(name, definition);
		},
	};
	const mod = await import(`../extension/tips-translate.ts?case=${++caseId}`);
	await mod.default(pi);
	const fire = async (event: string, payload: unknown = {}, ctx: unknown = host.ctx) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	const command = async (args: string, ctx: unknown = host.ctx) => {
		const definition = commands.get("tips-translate");
		if (!definition) throw new Error("tips-translate command not registered");
		return definition.handler(args, ctx);
	};
	return { fire, command, handlers };
}

describe("tips-translate original-preserving render hook", () => {
	test("a translated Text keeps its English source and follows IMPL swaps and removal", async () => {
		const host = makeHost();
		await load(host);

		const first = {
			translateText: (text: string) => text.replace("Tip: ", "T1: "),
			setUi() {},
			renderError() {},
		};
		shared[IMPL] = first;
		const text = new host.Text("Tip: Hello world");
		text.render(80);
		expect(text.text).toBe("T1: Hello world");

		const second = {
			translateText: (text: string) => text.replace("Tip: ", "T2: "),
			setUi() {},
			renderError() {},
		};
		shared[IMPL] = second;
		text.render(80);
		expect(text.text).toBe("T2: Hello world");

		shared[IMPL] = undefined;
		text.render(80);
		expect(text.text).toBe("Tip: Hello world");
	});

	test("a Text containing neither a tip line nor the pointer is never touched", async () => {
		const host = makeHost();
		await load(host);
		shared[IMPL] = {
			translateText: () => "SHOULD NOT BE USED",
			setUi() {},
			renderError() {},
		};
		const text = new host.Text("ordinary status line");
		text.render(80);
		text.render(120);
		expect(text.text).toBe("ordinary status line");
		expect(text.setTextCalls).toBe(0);
	});

	test("a pointer-less one-time reasoning notice is translated with the key preserved", async () => {
		const host = makeHost();
		makeStore({
			agentDir: host.agentDir,
			entries: {
				"reasoning-level-key": {
					en: "{0} changes the reasoning level",
					tr: "«한국어» {0} changes the reasoning level",
				},
			},
		});
		await load(host).then((api) => api.fire("session_start"));
		const text = new host.Text(`\x1b[2mTip: Ctrl+T changes the reasoning level\x1b[39m`);
		text.render(120);
		expect(text.text).toBe("\x1b[2m«한국어» Tip: «한국어» Ctrl+T changes the reasoning level\x1b[39m");
		expect(text.text).toContain("Ctrl+T");
	});

	test("a Tip: Text with no matching translation never calls setText", async () => {
		const host = makeHost();
		makeStore({ agentDir: host.agentDir });
		await load(host).then((api) => api.fire("session_start"));
		const text = new host.Text("Tip: this tip is not in the saved table");
		text.render(120);
		expect(text.text).toBe("Tip: this tip is not in the saved table");
		expect(text.setTextCalls).toBe(0);
	});

	test("the prototype hook is installed once across reloads", async () => {
		const host = makeHost();
		await load(host);
		const wrapped = (host.Text.prototype as unknown as Record<PropertyKey, unknown>).render;
		expect((host.Text.prototype as unknown as Record<PropertyKey, unknown>)[HOOK]).toBe(true);
		await load(host);
		expect((host.Text.prototype as unknown as Record<PropertyKey, unknown>).render).toBe(wrapped);
	});
});

describe("tips-translate session flow", () => {
	test("first run selects model and language, writes the store, and translates tip and pointer text", async () => {
		const host = makeHost();
		const done = host.ui.waitFor(/번역했습니다/);
		host.ui.selectQueue.push("fake/translator", "한국어");
		await load(host).then((api) => api.fire("session_start"));
		await done;

		expect(host.ui.selects.length).toBe(2);
		expect(host.ui.selects[0]).toContain("fake/translator");
		const saved = readStore(storePath(host.agentDir)).data!;
		expect(saved.language).toBe("한국어");
		expect(saved.model).toEqual({ provider: "fake", id: "translator" });
		expect(saved.sourceHash).toBe(catalogHash);
		expect(saved.omoVersion).toBe("9.9.9");
		expect(Object.keys(saved.table.entries).sort()).toEqual(["hello", "key"]);

		const tip = new host.Text(`\x1b[2mTip: Hello world\x1b[39m`);
		tip.render(120);
		expect(tip.text).toBe(`\x1b[2m«한국어» Tip: «한국어» Hello world\x1b[39m`);

		const pointer = new host.Text(POINTER_EN);
		pointer.render(120);
		expect(pointer.text).toBe(`«한국어» ${POINTER_EN}`);
	});

	test("a changed catalog asks once and yes translates only the changed tips", async () => {
		const host = makeHost();
		makeStore({
			agentDir: host.agentDir,
			source: "older-hash",
			entries: { hello: { en: "Hello world", tr: "번역 A" } },
		});
		host.ui.confirmQueue.push(true);
		const done = host.ui.waitFor(/번역했습니다/);
		await load(host).then((api) => api.fire("session_start"));
		await done;

		expect(host.ui.confirms.length).toBe(1);
		const saved = readStore(storePath(host.agentDir)).data!;
		expect(saved.sourceHash).toBe(catalogHash);
		expect(saved.table.entries.hello!.tr).toBe("번역 A");
		expect(saved.table.entries.key!.tr).toContain("«한국어»");

		const changed = new host.Text("Tip: Hello world");
		changed.render(120);
		expect(changed.text).toBe("«한국어» Tip: 번역 A");
	});

	test("declining a changed catalog stores the hash and never asks again", async () => {
		const host = makeHost();
		makeStore({ agentDir: host.agentDir, source: "older-hash" });
		host.ui.confirmQueue.push(false);
		const api = await load(host);
		await api.fire("session_start");

		expect(host.ui.confirms.length).toBe(1);
		const saved = readStore(storePath(host.agentDir)).data!;
		expect(saved.declinedHash).toBe(catalogHash);
		expect(saved.sourceHash).toBe("older-hash");

		await api.fire("session_start");
		expect(host.ui.confirms.length).toBe(1);
	});

	test("an unchanged catalog does not prompt", async () => {
		const host = makeHost();
		makeStore({ agentDir: host.agentDir });
		await load(host).then((api) => api.fire("session_start"));
		expect(host.ui.confirms.length).toBe(0);
		const translated = new host.Text("Tip: Hello world");
		translated.render(120);
		expect(translated.text).toBe("«한국어» Tip: «한국어» Hello world");
	});

	test("print mode never prompts and stays English without a store", async () => {
		const host = makeHost();
		host.ctx.mode = "print";
		await load(host).then((api) => api.fire("session_start"));
		expect(host.ui.selects.length).toBe(0);
		expect(existsSync(storePath(host.agentDir))).toBe(false);
		const text = new host.Text("Tip: Hello world");
		text.render(120);
		expect(text.text).toBe("Tip: Hello world");
	});

	test("a corrupt store stays English with a notice and no dialog", async () => {
		const host = makeHost();
		writeFileSync(storePath(host.agentDir), "{", "utf8");
		await load(host).then((api) => api.fire("session_start"));
		expect(host.ui.selects.length).toBe(0);
		expect(host.ui.confirms.length).toBe(0);
		expect(host.ui.notices.some((notice) => notice.message.includes("읽지 못했습니다"))).toBe(true);
		const text = new host.Text("Tip: Hello world");
		expect(() => text.render(120)).not.toThrow();
		expect(text.text).toBe("Tip: Hello world");
	});

	test("a missing Text seam gives one notice and leaves rendering to the host", async () => {
		const host = makeHost({ withText: false });
		const api = await load(host, { Text: undefined });
		await api.fire("session_start");
		await api.fire("session_start");
		expect(host.ui.notices.length).toBe(1);
		expect(host.ui.notices[0]!.message).toContain("꺼짐");
	});

	test("a missing getPackageDir gives one notice and English stays", async () => {
		const host = makeHost({ withPackageDir: false });
		makeStore({ agentDir: host.agentDir });
		const api = await load(host);
		await api.fire("session_start");
		expect(host.ui.notices.length).toBe(1);
		expect(host.ui.notices[0]!.message).toContain("getPackageDir");
		const text = new host.Text("Tip: Hello world");
		text.render(120);
		expect(text.text).toBe("Tip: Hello world");
	});

	test("a reload shutdown removes the implementation and the next load restores it", async () => {
		const host = makeHost();
		makeStore({ agentDir: host.agentDir });
		const first = await load(host);
		await first.fire("session_start");
		const text = new host.Text("Tip: Hello world");
		text.render(120);
		expect(text.text).toContain("«한국어»");

		await first.fire("session_shutdown", { reason: "reload" });
		text.render(120);
		expect(text.text).toBe("Tip: Hello world");

		const second = await load(host);
		await second.fire("session_start");
		text.render(120);
		expect(text.text).toContain("«한국어»");
	});

	test("a failing model call notifies an error and leaves no store behind", async () => {
		const registry = makeRegistry({
			complete: async () => {
				throw new Error("provider unavailable");
			},
		});
		const host = makeHost({ registry: registry.registry });
		host.ui.selectQueue.push("fake/translator", "한국어");
		const failed = host.ui.waitFor(/번역하지 못했습니다/);
		await load(host).then((api) => api.fire("session_start"));
		await failed;

		expect(host.ui.notices.some((notice) => notice.level === "error")).toBe(true);
		expect(existsSync(storePath(host.agentDir))).toBe(false);
		const text = new host.Text("Tip: Hello world");
		text.render(120);
		expect(text.text).toBe("Tip: Hello world");
	});

	test("a failing model call during a changed-catalog translation leaves the saved store byte-for-byte intact", async () => {
		const host = makeHost({
			registry: makeRegistry({
				complete: async () => {
					throw new Error("provider unavailable");
				},
			}).registry,
		});
		makeStore({ agentDir: host.agentDir, source: "older-hash", entries: {} });
		const path = storePath(host.agentDir);
		const before = readFileSync(path, "utf8");
		host.ui.confirmQueue.push(true);
		const failed = host.ui.waitFor(/번역하지 못했습니다/);
		await load(host).then((api) => api.fire("session_start"));
		await failed;
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(host.ui.notices.some((notice) => notice.level === "error")).toBe(true);
	});
});

describe("tips-translate command", () => {
	test("a language argument retranslates into that language", async () => {
		const host = makeHost();
		makeStore({ agentDir: host.agentDir });
		const api = await load(host);
		await api.fire("session_start");
		const done = host.ui.waitFor(/번역했습니다/);
		await api.command("日本語");
		await done;

		const saved = readStore(storePath(host.agentDir)).data!;
		expect(saved.language).toBe("日本語");
		const text = new host.Text("Tip: Hello world");
		text.render(120);
		expect(text.text).toBe("«日本語» Tip: «日本語» Hello world");
	});

	test("turning off in the menu restores English and turning on translates again", async () => {
		const host = makeHost();
		makeStore({ agentDir: host.agentDir });
		const api = await load(host);
		await api.fire("session_start");
		const text = new host.Text("Tip: Hello world");
		text.render(120);
		expect(text.text).toContain("«한국어»");

		host.ui.selectQueue.push("끄기");
		await api.command("");
		expect(readStore(storePath(host.agentDir)).data!.enabled).toBe(false);
		text.render(120);
		expect(text.text).toBe("Tip: Hello world");

		host.ui.selectQueue.push("켜기");
		await api.command("");
		expect(readStore(storePath(host.agentDir)).data!.enabled).toBe(true);
		text.render(120);
		expect(text.text).toContain("«한국어»");
	});

	test("status reports language, model, version, and counts", async () => {
		const host = makeHost();
		makeStore({ agentDir: host.agentDir });
		const api = await load(host);
		await api.fire("session_start");
		host.ui.selectQueue.push("상태");
		await api.command("");
		const status = host.ui.notices.at(-1)!.message;
		expect(status).toContain("한국어");
		expect(status).toContain("fake/translator");
		expect(status).toContain("9.9.9");
		expect(status).toContain("번역 2개");
	});
});
