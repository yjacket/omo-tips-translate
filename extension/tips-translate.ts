// The TUI draws every tip through Text.prototype.render. This wraps that method
// once per process and replaces only tip lines and the English pointer line with
// the saved translation. The English text stays recoverable: a module-local
// WeakMap remembers what this extension last showed for each Text instance, so
// swapping the global implementation (a language change) or removing it (turning
// off, /reload) restores the original text on the next render.
//
// Every seam is feature-detected. A missing Text class, catalog, store, or model
// leaves the display in English and reports at most one warning per session.
//
// Translation follows the routing `quick` category unless the user pinned a
// model: the chain is resolved at translation time through the installed
// omo-routing extension (the same layering /routing shows: builtin chain, then
// base, [native] and the active profile of ~/.omo/omo.jsonc), and each model is
// tried in order. When the chain cannot be read, the session model and then the
// last translating model stand in.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	POINTER_EN,
	POINTER_FORMS,
	PREFIX_EN,
	loadTemplates,
	sourceHash,
	type TipTemplate,
} from "../src/extract";
import { createMatcher, type Matcher, type Table } from "../src/match";
import {
	acquireLockToken,
	diffTemplates,
	readStore,
	releaseLock,
	storePath,
	writeStore,
	type ModelError,
	type StoreData,
} from "../src/store";
import { cleanError, translateTemplates, type Candidate } from "../src/translate";

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
const QUICK = "quick (자동)";
const COMMAND = "tips-translate";
// Reasoning suffixes omo-routing appends to chain specs ("provider/model:low").
const EFFORTS = new Set(["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);

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
// Where translation models come from: the quick chain, or one model on purpose.
type Source = { kind: "quick" } | { kind: "pinned"; model: ModelRef };

type Registry = {
	getAvailable?: () => Model[];
	find?: (provider: string, id: string) => Model | undefined;
	hasConfiguredAuth?: (model: Model) => boolean;
	complete?: (
		model: Model,
		context: { systemPrompt?: string; messages: unknown[] },
		options: Record<string, unknown>,
	) => Promise<{
		content?: Array<{ type?: string; text?: string }>;
		stopReason?: string;
		errorMessage?: string;
	}>;
};

type Context = {
	mode?: string;
	cwd?: string;
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
	if (POINTER_FORMS.some((pointer) => plain.includes(pointer))) return true;
	return plain.split("\n").some((line) => line.startsWith(PREFIX_EN));
}

function modelLabel(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function specModel(spec: unknown): ModelRef | undefined {
	if (typeof spec !== "string") return undefined;
	const slash = spec.indexOf("/");
	if (slash <= 0) return undefined;
	let id = spec.slice(slash + 1).trim();
	const colon = id.lastIndexOf(":");
	if (colon > 0 && EFFORTS.has(id.slice(colon + 1))) id = id.slice(0, colon);
	return id.length > 0 ? { provider: spec.slice(0, slash), id } : undefined;
}

function sourceOf(data: StoreData | undefined): Source {
	return data?.pinned ? { kind: "pinned", model: data.model } : { kind: "quick" };
}

function formatErrors(errors: ModelError[]): string {
	const shown = errors.slice(0, 3).map((item) => `${item.model}: ${item.error}`);
	if (errors.length > 3) shown.push(`외 ${errors.length - 3}개`);
	return shown.join(" · ");
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
	let warnedHeldLock = false;
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

	const notifyOn = (targetUi: Ui | undefined, message: string, level: "info" | "warning" | "error" = "info"): void => {
		try {
			targetUi?.notify?.(message, level);
		} catch {
			// A broken or stale notifier must not reject a background task.
		}
	};

	const notifyHeldLock = (targetUi: Ui | undefined): void => {
		if (warnedHeldLock) return;
		warnedHeldLock = true;
		notifyOn(targetUi, "다른 세션이 팁을 번역 중입니다. 끝나면 /reload로 반영됩니다");
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

	const setStatus = (text: string | undefined, targetUi: Ui | undefined = ui): void => {
		try {
			targetUi?.setStatus?.("omo-tips-translate", text);
		} catch {
			// Status is cosmetic.
		}
	};

	const runBackground = (task: () => Promise<void>): void => {
		void task().catch((error) => {
			notifySeamOnce(`tips-translate: 백그라운드 오류 (${errorMessage(error)}). 팁은 영어로 표시됩니다.`);
		});
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

	// The effective quick chain, read with omo-routing's own resolution so it
	// matches /routing. `problem` says why the chain is unusable.
	const quickChain = async (): Promise<{ models: ModelRef[]; problem?: string }> => {
		const file = join(agentDir, "git", "github.com", "yjacket", "omo-routing", "extension", "routing.ts");
		if (!existsSync(file)) return { models: [], problem: "omo-routing이 설치되어 있지 않습니다" };
		try {
			type Fn = (...args: unknown[]) => any;
			const routing = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
			const parseJsonc = routing.parseJsonc as Fn;
			const applyProfile = routing.applyProfile as Fn;
			const resolveProfileName = routing.resolveProfileName as Fn;
			const loadBuiltinRouting = routing.loadBuiltinRouting as Fn;
			const resolveRouting = routing.resolveRouting as Fn;
			if ([parseJsonc, applyProfile, resolveProfileName, loadBuiltinRouting, resolveRouting].some((fn) => typeof fn !== "function")) {
				return { models: [], problem: "omo-routing에서 체인 해석 함수를 찾지 못했습니다" };
			}
			const env = process.env;
			// The same home OMO itself reads omo.jsonc from.
			const home = env.HOME ?? env.USERPROFILE ?? homedir();
			const config = ["omo.jsonc", "omo.json"].map((name) => join(home, ".omo", name)).find((path) => existsSync(path));
			const raw = config ? parseJsonc(readFileSync(config, "utf8")) : {};
			const resolved = resolveRouting(applyProfile(raw, resolveProfileName(env)).config, loadBuiltinRouting(env));
			if (resolved?.sources?.categories?.quick === "disabled") return { models: [], problem: "quick 카테고리가 꺼져 있습니다" };
			const specs: unknown = resolved?.config?.categories?.quick?.models;
			const models: ModelRef[] = [];
			for (const spec of Array.isArray(specs) ? specs : []) {
				const model = specModel(spec);
				if (model && !models.some((known) => modelLabel(known) === modelLabel(model))) models.push(model);
			}
			return models.length > 0 ? { models } : { models, problem: "quick 체인이 비어 있습니다" };
		} catch (error) {
			return { models: [], problem: `quick 체인을 읽지 못했습니다: ${cleanError(error)}` };
		}
	};

	// Models to try in order. `notes` carries why the quick chain fell back.
	const candidatesFor = async (
		ctx: Context,
		source: Source,
		last: ModelRef | undefined,
	): Promise<{ models: Candidate[]; refs: Map<string, ModelRef>; notes: ModelError[] }> => {
		const refs = new Map<string, ModelRef>();
		const notes: ModelError[] = [];
		const add = (model: ModelRef | undefined) => {
			if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return;
			const label = modelLabel(model);
			if (!refs.has(label)) refs.set(label, { provider: model.provider, id: model.id });
		};
		if (source.kind === "pinned") {
			add(source.model);
		} else {
			const chain = await quickChain();
			// Like a task spawn, quick skips rungs this session has no sign-in for.
			const registry = ctx.modelRegistry;
			const connected = chain.models.filter((model) => {
				const found = registry?.find?.(model.provider, model.id);
				return found !== undefined && registry?.hasConfiguredAuth?.(found) !== false;
			});
			for (const model of connected) add(model);
			const problem =
				chain.problem ?? (connected.length === 0 ? "quick 체인에 연결된 모델이 없습니다" : undefined);
			if (problem !== undefined) {
				notes.push({ model: "quick", error: problem });
				add(ctx.model);
				add(last);
			}
		}
		const models = [...refs].map(([label, ref]) => ({ label, complete: completeFor(ctx, ref) }));
		return { models, refs, notes };
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
				// Session-bound providers (anthropic-subscription) refuse a request
				// without the session's absolute cwd.
				{ maxTokens: 16000, ...(typeof ctx.cwd === "string" && isAbsolute(ctx.cwd) ? { cwd: ctx.cwd } : {}) },
			);
			if (response?.stopReason === "aborted") throw new Error("번역이 중단되었습니다");
			if (response?.stopReason === "error") throw new Error(response.errorMessage || "모델 오류");
			const text = (response?.content ?? [])
				.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n");
			if (text.trim().length === 0) throw new Error("모델 응답이 비어 있습니다");
			return text;
		};
	};

	const updateStoreUnderLock = (
		path: string,
		mutate: (fresh: StoreData) => StoreData,
		targetUi: Ui | undefined,
	): StoreData | undefined => {
		const token = acquireLockToken(path);
		if (!token) {
			notifyHeldLock(targetUi);
			return undefined;
		}
		try {
			const read = readStore(path);
			if (read.error !== undefined || !read.data) {
				notifyOn(targetUi, `변경 사항을 저장하지 못했습니다: ${read.error ?? "저장된 번역이 없습니다"}`, "error");
				return undefined;
			}
			const next = mutate(read.data);
			writeStore(path, next);
			store = next;
			return next;
		} catch (error) {
			notifyOn(targetUi, `변경 사항을 저장하지 못했습니다: ${errorMessage(error)}`, "error");
			return undefined;
		} finally {
			releaseLock(path, token);
		}
	};

	const translate = async (
		ctx: Context,
		options: {
			language: string;
			// Omitted: the saved store's source (quick unless pinned).
			source?: Source;
			targets: TipTemplate[] | ((fresh: StoreData | undefined) => TipTemplate[]);
			includeFixed: boolean;
			useFreshSettings?: boolean;
			replaceEntries?: boolean;
			adoptExisting?: boolean;
		},
	): Promise<void> => {
		const currentUi = ctx.ui ?? ui;
		const target = storePath(agentDir);
		const token = acquireLockToken(target);
		if (!token) {
			notifyHeldLock(currentUi);
			return;
		}

		let done = 0;
		let total = 0;
		try {
			const fresh = readStore(target).data;
			if (fresh) store = fresh;

			const language = options.useFreshSettings && fresh ? fresh.language : options.language;
			const source = options.source ?? sourceOf(fresh ?? store);
			if (
				options.adoptExisting !== false &&
				fresh !== undefined &&
				fresh.sourceHash === hash &&
				fresh.language === language
			) {
				installMatcher(fresh.enabled ? fresh.table : undefined);
				activate();
				requestRender();
				notifyOn(currentUi, "다른 세션이 번역한 결과를 사용합니다");
				return;
			}

			const targets =
				typeof options.targets === "function" ? options.targets(fresh) : options.targets;
			if (targets.length === 0 && !options.includeFixed) {
				if (fresh) {
					const updated: StoreData = {
						...fresh,
						sourceHash: hash,
						omoVersion: version,
						updatedAt: new Date().toISOString(),
					};
					try {
						writeStore(target, updated);
						store = updated;
						installMatcher(updated.enabled ? updated.table : undefined);
					} catch (error) {
						notifyOn(currentUi, `변경 사항을 저장하지 못했습니다: ${errorMessage(error)}`, "error");
					}
				}
				return;
			}

			const chain = await candidatesFor(ctx, source, (fresh ?? store)?.model);
			if (chain.models.length === 0) {
				const why = formatErrors(chain.notes);
				notifyOn(currentUi, `번역에 사용할 모델이 없습니다${why ? ` (${why})` : ""}. 팁은 영어로 표시됩니다.`, "warning");
				return;
			}

			total = targets.length + (options.includeFixed ? 2 : 0);
			setStatus(`🌐 팁 0/${total}`, currentUi);
			const result = await translateTemplates({
				templates: targets,
				language,
				models: chain.models,
				includeFixed: options.includeFixed,
				onProgress: (nextDone, nextTotal) => {
					done = nextDone;
					total = nextTotal;
					setStatus(`🌐 팁 ${done}/${total}`, currentUi);
				},
			});

			const errors = [...chain.notes, ...result.errors];
			const translatedBy = chain.refs.get(result.models.at(-1) ?? "");
			if (Object.keys(result.entries).length === 0 || !translatedBy) {
				const why = formatErrors(errors) || "쓸 수 있는 번역이 없었습니다";
				notifyOn(currentUi, `팁을 번역하지 못했습니다 (${why}). 기존 번역을 유지하고 영어로 표시합니다.`, "error");
				// Keep the reasons for /tips-translate 상태; the table stays as it was.
				const saved = readStore(target).data;
				if (saved && errors.length > 0) {
					const failed: StoreData = { ...saved, lastErrors: errors, updatedAt: new Date().toISOString() };
					writeStore(target, failed);
					store = failed;
				}
				return;
			}

			const latest = readStore(target).data;
			const data: StoreData = {
				version: 1,
				omoVersion: version,
				sourceHash: hash,
				model: translatedBy,
				...(source.kind === "pinned" ? { pinned: true } : {}),
				...(errors.length > 0 ? { lastErrors: errors } : {}),
				language,
				enabled: latest?.enabled ?? true,
				...(latest?.declinedHash !== undefined ? { declinedHash: latest.declinedHash } : {}),
				table: options.replaceEntries
					? {
							prefix: result.prefix ?? PREFIX_EN,
							pointer: result.pointer ?? POINTER_EN,
							entries: result.entries,
						}
					: mergeTable(latest?.table, result),
				updatedAt: new Date().toISOString(),
			};
			writeStore(target, data);
			store = data;
			installMatcher(data.enabled ? data.table : undefined);
			activate();

			const count = Object.keys(result.entries).length;
			const failed = result.failed.length;
			notifyOn(
				currentUi,
				`팁을 ${language}로 번역했습니다 (${count}개${failed > 0 ? `, 실패 ${failed}개` : ""} · ${result.models.join(", ")})`,
				"info",
			);
			requestRender();
		} catch (error) {
			notifyOn(currentUi, `팁 번역 실패: ${errorMessage(error)}. 기존 번역을 유지합니다.`, "error");
		} finally {
			setStatus(undefined, currentUi);
			releaseLock(target, token);
		}
	};

	const pickModel = async (ctx: Context, current?: ModelRef): Promise<Source | undefined> => {
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
		const choice = await ui?.select?.("번역에 사용할 모델을 고르세요", [QUICK, ...models.map(modelLabel)]);
		if (!choice) return undefined;
		if (choice === QUICK) return { kind: "quick" };
		const model = models.find((known) => modelLabel(known) === choice);
		return model ? { kind: "pinned", model: { provider: model.provider, id: model.id } } : undefined;
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
		const language = await pickLanguage();
		if (!language) return;
		await translate(ctx, {
			language,
			source: { kind: "quick" },
			targets: templates,
			includeFixed: true,
		});
	};

	const runCommandTranslation = async (ctx: Context, language: string, source: Source): Promise<void> => {
		await translate(ctx, {
			language,
			source,
			targets: templates,
			includeFixed: true,
			replaceEntries: true,
			adoptExisting: false,
		});
	};

	const handleChangedCatalog = async (ctx: Context, path: string): Promise<void> => {
		// A catalog that only dropped tips (omo 5.1.54 removed two) has nothing new to translate: adopt its hash quietly.
		if (store && diffTemplates(templates, store.table).length === 0) {
			updateStoreUnderLock(
				path,
				(fresh) => ({ ...fresh, sourceHash: hash, omoVersion: version, updatedAt: new Date().toISOString() }),
				ctx.ui ?? ui,
			);
			return;
		}
		const accepted = await ui?.confirm?.(
			"팁이 바뀌었습니다",
			"omo 업데이트로 팁이 바뀌었습니다. 새 팁을 번역할까요?",
		);
		if (!accepted) {
			updateStoreUnderLock(
				path,
				(fresh) => ({ ...fresh, declinedHash: hash, updatedAt: new Date().toISOString() }),
				ctx.ui ?? ui,
			);
			return;
		}
		await translate(ctx, {
			language: store?.language ?? "한국어",
			targets: (fresh) =>
				diffTemplates(templates, fresh?.table ?? { prefix: PREFIX_EN, pointer: POINTER_EN, entries: {} }),
			includeFixed: false,
			useFreshSettings: true,
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
					runBackground(() => startFirstRun(ctx));
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

			runBackground(() => handleChangedCatalog(ctx, path));
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
					await runCommandTranslation(ctx, argument, sourceOf(store));
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
					await runCommandTranslation(ctx, language, sourceOf(store));
					return;
				}

				if (choice === "모델 바꾸기") {
					const source = await pickModel(ctx, store.model);
					if (!source) return;
					await runCommandTranslation(ctx, store.language, source);
					return;
				}

				if (choice === "다시 번역") {
					await runCommandTranslation(ctx, store.language, sourceOf(store));
					return;
				}

				if (choice === "끄기" || choice === "켜기") {
					const enabled = !store.enabled;
					const updated = updateStoreUnderLock(
						storePath(dir),
						(fresh) => ({ ...fresh, enabled, updatedAt: new Date().toISOString() }),
						ctx.ui ?? ui,
					);
					if (!updated) return;
					if (enabled) {
						installMatcher(updated.table);
						activate();
					} else {
						activeMatcher = undefined;
						if (shared[IMPL] === impl) shared[IMPL] = undefined;
					}
					requestRender();
					notify(enabled ? "팁 번역을 켰습니다." : "팁 번역을 껐습니다. 팁은 영어로 표시됩니다.", "info");
					return;
				}

				if (choice === "상태") {
					const failed = diffTemplates(templates, store.table).length;
					const source = store.pinned ? `고정 ${modelLabel(store.model)}` : QUICK;
					const errors = store.lastErrors ?? [];
					notify(
						`언어: ${store.language} · 모델: ${source} · 번역한 모델: ${modelLabel(store.model)} · ` +
							`OMO: ${store.omoVersion} · 번역 ${Object.keys(store.table.entries).length}개 · 실패 ${failed}개` +
							(errors.length > 0 ? `\n최근 오류: ${formatErrors(errors)}` : ""),
						"info",
					);
				}
			},
		});
	}

}
