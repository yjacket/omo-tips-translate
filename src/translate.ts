import { POINTER_EN, PREFIX_EN, type TipTemplate } from "./extract";
import type { Entry } from "./match";

export type Complete = (system: string, user: string) => Promise<string>;

// One model of the chain, tried in order. `label` is "provider/id".
export type Candidate = { label: string; complete: Complete };

export type ModelError = { model: string; error: string };

export type TranslateResult = {
	entries: Record<string, Entry>;
	prefix?: string;
	pointer?: string;
	failed: string[];
	// Labels of the models whose replies were used, in the order they were used.
	models: string[];
	// The last error of every model that was given up on, in chain order.
	errors: ModelError[];
};

const PREFIX_KEY = "__prefix";
const POINTER_KEY = "__pointer";
const DEFAULT_BATCH_SIZE = 40;
const RETRY_BATCH_SIZE = 10;

// Sorted list of "{n}" tokens, duplicates kept. Must behave exactly like
// placeholders() from src/match.ts.
function placeholders(s: string): string[] {
	return (s.match(/\{\d+\}/g) ?? []).sort();
}

function samePlaceholders(a: string, b: string): boolean {
	const left = placeholders(a);
	const right = placeholders(b);
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

function isUsableTranslation(en: string, value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.trim().length === 0) return false;
	if (value.includes("\n") || value.includes("\r")) return false;
	return samePlaceholders(en, value);
}

function abortError(): Error {
	const error = new Error("translation aborted");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError());

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

const SECRET_PATTERNS = [
	/\b(Bearer|Basic)\s+\S+/gi,
	/\b(sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{8,}/g,
	/\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*\S+/gi,
	/[A-Za-z0-9+/_-]{32,}={0,2}/g,
];
const ERROR_LIMIT = 160;

// One line, no credentials, short enough for a notice: error text from a
// provider may echo request headers or keys.
export function cleanError(error: unknown): string {
	let text = error instanceof Error ? error.message : String(error);
	text = text.replace(/\s+/g, " ").trim();
	for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "…");
	if (text.length === 0) text = "알 수 없는 오류";
	return text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT - 1)}…` : text;
}

function chunk<T>(values: T[], size: number): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < values.length; i += size) {
		batches.push(values.slice(i, i + size));
	}
	return batches;
}

export function buildPrompt(
	language: string,
	items: Record<string, string>,
): { system: string; user: string } {
	const system =
		`UI tip strings for a terminal coding agent; translate into ${language}; ` +
		"keep `{0}` tokens exactly, reorder allowed; keep commands (/x), flags (--x), " +
		"file names, key names, code in backticks untranslated; one line each; " +
		"return ONLY a JSON object with the same keys";
	return { system, user: JSON.stringify(items) };
}

export function parseReply(reply: string): Record<string, string> | undefined {
	let text = reply.trim();
	if (text.startsWith("```")) {
		const firstNewline = text.indexOf("\n");
		if (firstNewline === -1) return undefined;
		text = text.slice(firstNewline + 1).trimEnd();
		if (text.endsWith("```")) text = text.slice(0, -3).trimEnd();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start === -1 || end <= start) return undefined;
		try {
			parsed = JSON.parse(text.slice(start, end + 1));
		} catch {
			return undefined;
		}
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

export async function translateTemplates(opts: {
	templates: TipTemplate[];
	language: string;
	models: Candidate[];
	includeFixed: boolean;
	batchSize?: number;
	onProgress?: (done: number, total: number) => void;
	signal?: AbortSignal;
}): Promise<TranslateResult> {
	const { templates, language, models, includeFixed, onProgress, signal } = opts;
	const batchSize =
		typeof opts.batchSize === "number" && opts.batchSize > 0
			? Math.floor(opts.batchSize)
			: DEFAULT_BATCH_SIZE;

	throwIfAborted(signal);

	const items: Record<string, string> = {};
	if (includeFixed) {
		items[PREFIX_KEY] = PREFIX_EN;
		items[POINTER_KEY] = POINTER_EN;
	}
	for (const template of templates) {
		if (!(template.id in items)) items[template.id] = template.en;
	}

	const ids = Object.keys(items);
	const total = ids.length;
	const done = new Set<string>();
	const entries: Record<string, Entry> = {};

	const used: string[] = [];
	const errors = new Map<string, string>();
	if (total === 0) {
		onProgress?.(0, 0);
		return { entries, failed: [], models: used, errors: [] };
	}

	const progress = () => onProgress?.(done.size, total);

	// The chain stays on the first model that answers. A model that throws or
	// sends no JSON object is given up on for the rest of the run, and the same
	// batch goes to the next model; bad keys in a parsed reply are left to the
	// retry pass with the same model.
	let current = 0;
	const ask = async (prompt: { system: string; user: string }): Promise<Record<string, string> | undefined> => {
		while (current < models.length) {
			const model = models[current]!;
			try {
				const reply = await raceAbort(model.complete(prompt.system, prompt.user), signal);
				throwIfAborted(signal);
				const parsed = parseReply(reply);
				if (parsed) {
					if (!used.includes(model.label)) used.push(model.label);
					return parsed;
				}
				errors.set(model.label, "응답이 JSON 객체가 아닙니다");
			} catch (error) {
				if (isAbortError(error)) throw error;
				throwIfAborted(signal);
				errors.set(model.label, cleanError(error));
			}
			current++;
		}
		return undefined;
	};

	const runBatch = async (batch: string[]): Promise<string[]> => {
		throwIfAborted(signal);
		const asked: Record<string, string> = {};
		for (const id of batch) asked[id] = items[id]!;

		const parsed = await ask(buildPrompt(language, asked));
		if (!parsed) return batch;

		const bad: string[] = [];
		for (const id of batch) {
			const value = parsed[id];
			if (isUsableTranslation(asked[id]!, value)) {
				entries[id] = { en: asked[id]!, tr: value };
				done.add(id);
			} else {
				bad.push(id);
			}
		}
		return bad;
	};

	let pending: string[] = [];
	for (const batch of chunk(ids, batchSize)) {
		const bad = await runBatch(batch);
		pending.push(...bad);
		progress();
	}

	if (pending.length > 0) {
		const failed: string[] = [];
		for (const batch of chunk(pending, RETRY_BATCH_SIZE)) {
			failed.push(...(await runBatch(batch)));
			progress();
		}
		for (const id of failed) done.add(id);
		progress();
		return finalize(entries, failed, used, models, errors);
	}

	return finalize(entries, [], used, models, errors);
}

function finalize(
	entries: Record<string, Entry>,
	failedIds: string[],
	used: string[],
	models: Candidate[],
	errors: Map<string, string>,
): TranslateResult {
	const fixedPrefix = entries[PREFIX_KEY];
	const fixedPointer = entries[POINTER_KEY];
	const translatedEntries: Record<string, Entry> = {};
	for (const [id, entry] of Object.entries(entries)) {
		if (id !== PREFIX_KEY && id !== POINTER_KEY) translatedEntries[id] = entry;
	}

	const result: TranslateResult = {
		entries: translatedEntries,
		failed: [...failedIds].sort(),
		models: used,
		errors: models.flatMap((model) => {
			const error = errors.get(model.label);
			return error === undefined ? [] : [{ model: model.label, error }];
		}),
	};
	if (fixedPrefix) result.prefix = fixedPrefix.tr;
	if (fixedPointer) result.pointer = fixedPointer.tr;
	return result;
}
