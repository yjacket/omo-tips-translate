// The TUI draws every tip through Text.prototype.render. This wraps that method
// once per process and replaces only tip lines and the English pointer line with
// the saved translation. The English text stays recoverable: a module-local
// WeakMap remembers what this extension last showed for each Text instance, so
// swapping the global implementation (a language change) or removing it (turning
// off, /reload) restores the original text on the next render.
//
// Every seam is feature-detected. A missing Text class, catalog, store, or model
// leaves the display in English and reports at most one warning per session.

import { existsSync } from "node:fs";

import {
	POINTER_EN,
	PREFIX_EN,
	loadTemplates,
	sourceHash,
	type TipTemplate,
} from "../src/extract";
import { createMatcher, type Matcher, type Table } from "../src/match";
import {
	acquireLock,
	diffTemplates,
	readStore,
	releaseLock,
	storePath,
	writeStore,
	type StoreData,
} from "../src/store";
import { translateTemplates } from "../src/translate";

const HOOK = Symbol.for("omo.tips-translate.text-hook.v1");
const IMPL = Symbol.for("omo.tips-translate.impl.v1");
const SGR = new RegExp("\\x1b\\[[0-9;]*m", "g");

const LANGUAGES = [
	"한국어",
	"日本語",
	"简体中文",
	"繁體中文",
	"Español",
	"Français",
	"Deutsch",
	"Português",
	"Русский",
];
const DIRECT_INPUT = "직접 입력";
const COMMAND = "tips-translate";

type Ui = {
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	confirm?: (title: string, message: string) => Promise<boolean>;
	input?: (title: string, placeholder?: string) => Promise<string | undefined>;
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
	setStatus?: (key: string, text: string | undefined) => void;
	requestRender?: () => void;
};

type ModelRef = { provider: string; id: string };
type Model = ModelRef & Record<string, unknown>;

type Registry = {
	getAvailable?: () => Model[];
	find?: (provider: string, id: string) => Model | undefined;
	hasConfiguredAuth?: (model: Model) => boolean;
	complete?: (
		model: Model,
		context: { systemPrompt?: string; messages: unknown[] },
		options: Record<string, unknown>,
	) => Promise<{ content?: Array<{ type?: string; text?: string }>; stopReason?: string }>;
};

type Context = {
	mode?: string;
	agentDir?: string;
	model?: Model;
	modelRegistry?: Registry;
	ui?: Ui;
};

type Impl = {
	translateText(text: string): string;
	setUi(ui: Ui | undefined): void;
	renderError(error: unknown): void;
};

type Seen = { orig: string; shown: string };

type ExtensionApi = {
	on?: (event: string, handler: (event: unknown, ctx: Context) => unknown) => void;
	registerCommand?: (name: string, definition: { description?: string; handler: (args: string, ctx: Context) => unknown }) => void;
};

const shared = globalThis as Record<PropertyKey, unknown>;
const seen = new WeakMap<object, Seen>();

function currentImpl(): Impl | undefined {
	return shared[IMPL] as Impl | undefined;
}

function plainText(text: string): string {
	return text.replace(SGR, "");
}

function isTipText(text: string): boolean {
	const plain = plainText(text);
	if (plain.includes(POINTER_EN)) return true;
	return plain.split("\n").some((line) => line.startsWith(PREFIX_EN));
}

function modelLabel(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function installHook(TextClass: unknown): string | undefined {
	const proto = (TextClass as { prototype?: Record<PropertyKey, unknown> } | undefined)?.prototype;
	if (!proto || typeof proto.render !== "function") return "pi-tui Text.prototype.render not found";
	if (proto[HOOK]) return undefined;

	const original = proto.render as (this: { text?: unknown; setText?: (text: string) => void }, width: number) => unknown;
	proto.render = function (this: { text?: unknown; setText?: (text: string) => void }, width: number) {
		try {
			const before = this.text;
			if (typeof before === "string") {
				const rec = seen.get(this);
				const source = rec && before === rec.shown ? rec.orig : before;

				if (isTipText(source)) {
					const impl = currentImpl();
					const output = impl ? impl.translateText(source) : source;
					if (output !== this.text) {
						if (typeof this.setText === "function") this.setText(output);
						else this.text = output;
					}
					if (output !== source) seen.set(this, { orig: source, shown: output });
					else seen.delete(this);
				} else if (rec) {
					seen.delete(this);
				}
			}
		} catch (error) {
			try {
				currentImpl()?.renderError(error);
			} catch {
				// A failing render must still draw the host's own output.
			}
		}
		return original.call(this, width);
	};
	proto[HOOK] = true;
	return undefined;
}

function mergeTable(base: Table | undefined, result: { entries: Record<string, { en: string; tr: string }>; prefix?: string; pointer?: string }): Table {
	return {
		prefix: result.prefix ?? base?.prefix ?? PREFIX_EN,
		pointer: result.pointer ?? base?.pointer ?? POINTER_EN,
		entries: { ...(base?.entries ?? {}), ...result.entries },
	};
}

export default async function tipsTranslate(pi: ExtensionApi): Promise<void> {
	let ui: Ui | undefined;
	let problem: string | undefined;
	let warnedSeam = false;
	let warnedRender = false;
	let pendingWarning: string | undefined;

	let TextClass: unknown;
	let getPackageDir: (() => string) | undefined;
	let getAgentDir: (() => string) | undefined;
	let version = "unknown";

	let templates: TipTemplate[] = [];
	let hash = "";
	let agentDir = "";
	let activeMatcher: Matcher | undefined;
	let store: StoreData | undefined;

	const notify = (message: string, level: "info" | "warning" | "error" = "info"): void => {
		try {
			ui?.notify?.(message, level);
		} catch {
			// A broken notifier must not break translation or rendering.
		}
	};

	const notifySeamOnce = (message: string): void => {
		if (warnedSeam) return;
		if (typeof ui?.notify !== "function") {
			pendingWarning = message;
			return;
		}
		warnedSeam = true;
		notify(message, "warning");
	};

	const requestRender = (): void => {
		try {
			if (typeof ui?.requestRender === "function") ui.requestRender();
			else {
				const host = (ui as { tui?: { requestRender?: () => void } } | undefined)?.tui;
				if (typeof host?.requestRender === "function") host.requestRender();
			}
		} catch {
			// The next frame picks up the new text.
		}
	};

	const setStatus = (text: string | undefined): void => {
		try {
			ui?.setStatus?.("omo-tips-translate", text);
		} catch {
			// Status is cosmetic.
		}
	};

	const activate = (): void => {
		if (shared[IMPL] === undefined || shared[IMPL] === impl) shared[IMPL] = impl;
	};

	const installMatcher = (table: Table | undefined): void => {
		try {
			activeMatcher = table ? createMatcher(table) : undefined;
		} catch {
			activeMatcher = undefined;
		}
	};

	const impl: Impl = {
		translateText(text: string): string {
			if (!activeMatcher) return text;
			return activeMatcher.translateText(text);
		},
		setUi(next: Ui | undefined): void {
			ui = next;
			if (pendingWarning !== undefined && typeof ui?.notify === "function") {
				const message = pendingWarning;
				pendingWarning = undefined;
				notifySeamOnce(message);
			}
		},
		renderError(error: unknown): void {
			if (warnedRender) return;
			warnedRender = true;
			notify(`tips-translate 렌더 오류: ${errorMessage(error)}. 팁은 영어로 표시됩니다.`, "warning");
		},
	};

	try {
		const tui = (await import("@earendil-works/pi-tui")) as Record<string, unknown>;
		const senpi = (await import("@code-yeongyu/senpi")) as Record<string, unknown>;
		TextClass = tui.Text;
		if (typeof senpi.getPackageDir === "function") {
			getPackageDir = senpi.getPackageDir as () => string;
		}
		if (typeof senpi.getAgentDir === "function") {
			getAgentDir = senpi.getAgentDir as () => string;
		}
		if (typeof senpi.VERSION === "string") version = senpi.VERSION;

		problem = installHook(TextClass);
		if (problem === undefined) activate();
	} catch (error) {
		problem = errorMessage(error);
	}

	const loadCatalog = (): boolean => {
		if (typeof getPackageDir !== "function") {
			notifySeamOnce("tips-translate: OMO 설치 경로를 찾지 못했습니다 (getPackageDir). 팁은 영어로 표시됩니다.");
			return false;
		}
		try {
			const loaded = loadTemplates(getPackageDir());
			templates = loaded.templates;
			hash = sourceHash(templates);
			if (templates.length === 0) {
				notifySeamOnce("tips-translate: 팁 원문을 찾지 못했습니다. 팁은 영어로 표시됩니다.");
				return false;
			}
			return true;
		} catch (error) {
			notifySeamOnce(`tips-translate: 팁 원문을 읽지 못했습니다 (${errorMessage(error)}). 팁은 영어로 표시됩니다.`);
			return false;
		}
	};

	const resolveAgentDir = (ctx: Context): string | undefined => {
		if (typeof ctx.agentDir === "string" && ctx.agentDir.length > 0) return ctx.agentDir;
		try {
			return getAgentDir?.();
		} catch {
			return undefined;
		}
	};

	const completeFor = (ctx: Context, model: ModelRef) => {
		return async (system: string, user: string): Promise<string> => {
			const registry = ctx.modelRegistry;
			if (typeof registry?.complete !== "function" || typeof registry.find !== "function") {
				throw new Error("모델을 사용할 수 없습니다");
			}
			const found = registry.find(model.provider, model.id);
			if (!found) throw new Error(`모델을 찾지 못했습니다: ${modelLabel(model)}`);
			if (typeof registry.hasConfiguredAuth === "function" && !registry.hasConfiguredAuth(found)) {
				throw new Error(`모델 인증이 없습니다: ${modelLabel(model)}`);
			}
			const response = await registry.complete(
				found,
				{
					systemPrompt: system,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: user }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 16000 },
			);
			if (response?.stopReason === "aborted") throw new Error("번역이 중단되었습니다");
			const text = (response?.content ?? [])
				.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n");
			if (text.trim().length === 0) throw new Error("모델 응답이 비어 있습니다");
			return text;
		};
	};

	const translate = async (
		ctx: Context,
		options: {
			language: string;
			model: ModelRef;
			targets: TipTemplate[];
			includeFixed: boolean;
			base?: StoreData;
			replaceEntries?: boolean;
		},
	): Promise<void> => {
		const currentUi = ctx.ui ?? ui;
		const target = storePath(agentDir);
		if (!acquireLock(target)) return;

		let done = 0;
		let total = options.targets.length + (options.includeFixed ? 2 : 0);
		setStatus(`🌐 팁 0/${total}`);
		try {
			const result = await translateTemplates({
				templates: options.targets,
				language: options.language,
				complete: completeFor(ctx, options.model),
				includeFixed: options.includeFixed,
				onProgress: (nextDone, nextTotal) => {
					done = nextDone;
					total = nextTotal;
					setStatus(`🌐 팁 ${done}/${total}`);
				},
			});

			if (Object.keys(result.entries).length === 0) {
				currentUi?.notify?.("팁을 번역하지 못했습니다. 기존 번역을 유지하고 영어로 표시합니다.", "error");
				return;
			}

			const base = options.base ?? store;
			const data: StoreData = {
				version: 1,
				omoVersion: version,
				sourceHash: hash,
				model: { provider: options.model.provider, id: options.model.id },
				language: options.language,
				enabled: true,
				...(base?.declinedHash !== undefined ? { declinedHash: base.declinedHash } : {}),
				table: options.replaceEntries
					? {
							prefix: result.prefix ?? PREFIX_EN,
							pointer: result.pointer ?? POINTER_EN,
							entries: result.entries,
						}
					: mergeTable(base?.table, result),
				updatedAt: new Date().toISOString(),
			};
			writeStore(target, data);
			store = data;
			installMatcher(data.table);
			activate();

			const count = Object.keys(result.entries).length;
			const failed = result.failed.length;
			currentUi?.notify?.(
				`팁을 ${options.language}로 번역했습니다 (${count}개${failed > 0 ? `, 실패 ${failed}개` : ""})`,
				"info",
			);
			requestRender();
		} catch (error) {
			currentUi?.notify?.(`팁 번역 실패: ${errorMessage(error)}. 기존 번역을 유지합니다.`, "error");
		} finally {
			setStatus(undefined);
			releaseLock(target);
		}
	};

	const pickModel = async (ctx: Context, current?: ModelRef): Promise<Model | undefined> => {
		const registry = ctx.modelRegistry;
		const models: Model[] = [];
		const add = (model: Model | undefined) => {
			if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return;
			if (models.some((existing) => modelLabel(existing) === modelLabel(model))) return;
			models.push(model);
		};
		if (current) add(registry?.find?.(current.provider, current.id) ?? (current as Model));
		add(ctx.model);
		if (typeof registry?.getAvailable === "function") {
			try {
				for (const model of registry.getAvailable()) add(model);
			} catch {
				// An unavailable registry leaves the current model as the only option.
			}
		}
		if (models.length === 0) {
			notify("번역에 사용할 모델이 없습니다. 팁은 영어로 표시됩니다.", "warning");
			return undefined;
		}
		const labels = models.map(modelLabel);
		const choice = await ui?.select?.("번역에 사용할 모델을 고르세요", labels);
		if (!choice) return undefined;
		return models.find((model) => modelLabel(model) === choice) ?? models[0];
	};

	const pickLanguage = async (current?: string): Promise<string | undefined> => {
		const options = [...LANGUAGES];
		if (current && !options.includes(current)) options.unshift(current);
		options.push(DIRECT_INPUT);
		const choice = await ui?.select?.("팁을 표시할 언어를 고르세요", options);
		if (!choice) return undefined;
		if (choice !== DIRECT_INPUT) return choice;
		const typed = await ui?.input?.("번역할 언어를 입력하세요", "예: Italiano");
		const language = typed?.trim();
		return language && language.length > 0 ? language : undefined;
	};

	const startFirstRun = async (ctx: Context): Promise<void> => {
		const model = await pickModel(ctx, ctx.model);
		if (!model) return;
		const language = await pickLanguage();
		if (!language) return;
		void translate(ctx, {
			language,
			model: { provider: model.provider, id: model.id },
			targets: templates,
			includeFixed: true,
		});
	};

	const runCommandTranslation = async (ctx: Context, language: string, base?: StoreData): Promise<void> => {
		const modelRef = base?.model ?? (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
		let model = modelRef;
		if (!model) {
			const picked = await pickModel(ctx);
			if (!picked) return;
			model = { provider: picked.provider, id: picked.id };
		}
		await translate(ctx, {
			language,
			model,
			targets: templates,
			includeFixed: true,
			base,
			replaceEntries: true,
		});
	};

	if (typeof pi?.on === "function") {
		pi.on("session_start", async (_event, ctx) => {
			impl.setUi(ctx?.ui ?? ui);
			if (problem !== undefined) {
				notifySeamOnce(`tips-translate 꺼짐 (${problem}). 팁은 영어로 표시됩니다.`);
				return;
			}
			if (!loadCatalog()) return;

			const dir = resolveAgentDir(ctx);
			if (!dir) {
				notifySeamOnce("tips-translate: OMO 에이전트 디렉터리를 찾지 못했습니다. 팁은 영어로 표시됩니다.");
				return;
			}
			agentDir = dir;
			const path = storePath(dir);
			const existed = existsSync(path);
			const read = readStore(path);

			if (read.error !== undefined) {
				if (existed) {
					notifySeamOnce(`tips-translate: 저장된 번역을 읽지 못했습니다 (${read.error}). 팁은 영어로 표시됩니다.`);
				} else if (ctx.mode === "tui") {
					await startFirstRun(ctx);
				}
				return;
			}

			store = read.data;
			if (!store || !store.enabled) {
				installMatcher(undefined);
				if (shared[IMPL] === impl) shared[IMPL] = undefined;
				return;
			}

			installMatcher(store.table);
			activate();

			if (store.sourceHash === hash || store.declinedHash === hash) return;
			if (ctx.mode !== "tui" || typeof ui?.confirm !== "function") return;

			const accepted = await ui.confirm(
				"팁이 바뀌었습니다",
				"omo 업데이트로 팁이 바뀌었습니다. 새 팁을 번역할까요?",
			);
			if (!accepted) {
				const declined: StoreData = {
					...store,
					declinedHash: hash,
					updatedAt: new Date().toISOString(),
				};
				try {
					writeStore(path, declined);
					store = declined;
				} catch (error) {
					notify(`변경 사항을 저장하지 못했습니다: ${errorMessage(error)}`, "error");
				}
				return;
			}

			const targets = diffTemplates(templates, store.table);
			if (targets.length === 0) {
				const updated: StoreData = { ...store, sourceHash: hash, omoVersion: version, updatedAt: new Date().toISOString() };
				try {
					writeStore(path, updated);
					store = updated;
				} catch (error) {
					notify(`변경 사항을 저장하지 못했습니다: ${errorMessage(error)}`, "error");
				}
				return;
			}
			const base = store;
			void translate(ctx, {
				language: store.language,
				model: store.model,
				targets,
				includeFixed: false,
				base,
			});
		});

		pi.on("session_shutdown", () => {
			if (shared[IMPL] === impl) shared[IMPL] = undefined;
			activeMatcher = undefined;
		});
	}

	if (typeof pi?.registerCommand === "function") {
		pi.registerCommand(COMMAND, {
			description: "팁 표시 언어 바꾸기",
			handler: async (args, ctx) => {
				impl.setUi(ctx?.ui ?? ui);
				if (problem !== undefined) {
					notifySeamOnce(`tips-translate 꺼짐 (${problem}). 팁은 영어로 표시됩니다.`);
					return;
				}
				if (templates.length === 0 && !loadCatalog()) return;
				const dir = resolveAgentDir(ctx);
				if (!dir) {
					notify("OMO 에이전트 디렉터리를 찾지 못했습니다.", "error");
					return;
				}
				agentDir = dir;
				if (!store) {
					const read = readStore(storePath(dir));
					store = read.data;
				}

				const argument = typeof args === "string" ? args.trim() : "";
				if (argument.length > 0) {
					await runCommandTranslation(ctx, argument, store);
					return;
				}

				if (!store) {
					await startFirstRun(ctx);
					return;
				}

				const choice = await ui?.select?.("팁 번역", [
					"언어 바꾸기",
					"모델 바꾸기",
					"다시 번역",
					store.enabled ? "끄기" : "켜기",
					"상태",
				]);
				if (!choice) return;

				if (choice === "언어 바꾸기") {
					const language = await pickLanguage(store.language);
					if (!language) return;
					await runCommandTranslation(ctx, language, store);
					return;
				}

				if (choice === "모델 바꾸기") {
					const model = await pickModel(ctx, store.model);
					if (!model) return;
					const updated: StoreData = {
						...store,
						model: { provider: model.provider, id: model.id },
						updatedAt: new Date().toISOString(),
					};
					try {
						writeStore(storePath(dir), updated);
						store = updated;
						notify(`번역 모델을 ${modelLabel(model)}로 바꿨습니다.`, "info");
					} catch (error) {
						notify(`모델 설정을 저장하지 못했습니다: ${errorMessage(error)}`, "error");
					}
					return;
				}

				if (choice === "다시 번역") {
					await runCommandTranslation(ctx, store.language, store);
					return;
				}

				if (choice === "끄기" || choice === "켜기") {
					const enabled = !store.enabled;
					const updated: StoreData = { ...store, enabled, updatedAt: new Date().toISOString() };
					try {
						writeStore(storePath(dir), updated);
						store = updated;
						if (enabled) {
							installMatcher(store.table);
							activate();
						} else {
							activeMatcher = undefined;
							if (shared[IMPL] === impl) shared[IMPL] = undefined;
						}
						requestRender();
						notify(enabled ? "팁 번역을 켰습니다." : "팁 번역을 껐습니다. 팁은 영어로 표시됩니다.", "info");
					} catch (error) {
						notify(`설정을 저장하지 못했습니다: ${errorMessage(error)}`, "error");
					}
					return;
				}

				if (choice === "상태") {
					const failed = diffTemplates(templates, store.table).length;
					notify(
						`언어: ${store.language} · 모델: ${modelLabel(store.model)} · OMO: ${store.omoVersion} · ` +
							`번역 ${Object.keys(store.table.entries).length}개 · 실패 ${failed}개`,
						"info",
					);
				}
			},
		});
	}

}
