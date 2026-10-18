import { describe, expect, test } from "bun:test";
import { POINTER_EN, PREFIX_EN, type TipTemplate } from "../src/extract";
import {
	buildPrompt,
	parseReply,
	translateTemplates,
	type Complete,
} from "../src/translate";

function template(id: string, en: string): TipTemplate {
	return { id, en, slots: (en.match(/\{\d+\}/g) ?? []).length };
}

const POINTER_TR = "↳ 팁 전체 안내가 필요하면 물어보세요 — give-me-tips 스킬에 있습니다.";

const TRANSLATIONS: Record<string, string> = {
	[PREFIX_EN]: "팁: ",
	[POINTER_EN]: POINTER_TR,
	Hello: "안녕하세요",
	"Press {0} to stop.": "{0}를 눌러 멈추세요.",
	"Run {0} then {1}.": "{0} 실행 후 {1}.",
};

function translator(
	transform: (en: string, call: number) => string | undefined = (en) => TRANSLATIONS[en],
): { complete: Complete; calls: string[][]; count: () => number } {
	const calls: string[][] = [];
	const complete: Complete = async (_system, user) => {
		const items = JSON.parse(user) as Record<string, string>;
		const call = calls.length;
		calls.push(items);
		const reply: Record<string, string> = {};
		for (const [key, en] of Object.entries(items)) {
			const value = transform(en, call);
			if (value !== undefined) reply[key] = value;
		}
		return JSON.stringify(reply);
	};
	return { complete, calls, count: () => calls.length };
}

describe("buildPrompt", () => {
	test("names the language and keeps the fixed rules", () => {
		const { system, user } = buildPrompt("한국어", { a: "Hello" });
		expect(system).toContain("한국어");
		expect(system).toContain("`{0}`");
		expect(system).toContain("return ONLY a JSON object with the same keys");
		expect(JSON.parse(user)).toEqual({ a: "Hello" });
	});
});

describe("parseReply", () => {
	test("parses plain and fenced JSON", () => {
		expect(parseReply('{"a":"안녕"}')).toEqual({ a: "안녕" });
		expect(parseReply('```json\n{"a":"안녕"}\n```')).toEqual({ a: "안녕" });
		expect(parseReply("```\n{\"a\":\"안녕\"}\n```")).toEqual({ a: "안녕" });
	});

	test("returns undefined for non-JSON and non-objects", () => {
		expect(parseReply("not json at all")).toBeUndefined();
		expect(parseReply("[1,2,3]")).toBeUndefined();
		expect(parseReply("null")).toBeUndefined();
		expect(parseReply("```")).toBeUndefined();
	});
});

describe("translateTemplates", () => {
	test("translates templates and the fixed strings", async () => {
		const fake = translator();
		const result = await translateTemplates({
			templates: [template("hello", "Hello"), template("stop", "Press {0} to stop.")],
			language: "한국어",
			complete: fake.complete,
			includeFixed: true,
		});

		expect(result.prefix).toBe("팁: ");
		expect(result.pointer).toBe(POINTER_TR);
		expect(result.entries).toEqual({
			hello: { en: "Hello", tr: "안녕하세요" },
			stop: { en: "Press {0} to stop.", tr: "{0}를 눌러 멈추세요." },
		});
		expect(result.entries.__prefix).toBeUndefined();
		expect(result.entries.__pointer).toBeUndefined();
		expect(result.failed).toEqual([]);
		expect(fake.calls[0]).toEqual({ __prefix: PREFIX_EN, __pointer: POINTER_EN, hello: "Hello", stop: "Press {0} to stop." });
	});

	test("omits fixed strings when includeFixed is false", async () => {
		const fake = translator();
		const result = await translateTemplates({
			templates: [template("hello", "Hello")],
			language: "한국어",
			complete: fake.complete,
			includeFixed: false,
		});

		expect(result.prefix).toBeUndefined();
		expect(result.pointer).toBeUndefined();
		expect(result.entries).toEqual({ hello: { en: "Hello", tr: "안녕하세요" } });
		expect(Object.keys(fake.calls[0]!)).toEqual(["hello"]);
	});

	test("tolerates a ```json fenced reply", async () => {
		const complete: Complete = async (_system, user) => {
			const items = JSON.parse(user) as Record<string, string>;
			const reply: Record<string, string> = {};
			for (const [key, en] of Object.entries(items)) reply[key] = TRANSLATIONS[en]!;
			return "```json\n" + JSON.stringify(reply) + "\n```";
		};

		const result = await translateTemplates({
			templates: [template("hello", "Hello")],
			language: "한국어",
			complete,
			includeFixed: false,
		});

		expect(result.entries.hello).toEqual({ en: "Hello", tr: "안녕하세요" });
		expect(result.failed).toEqual([]);
	});

	test("retries a translation with missing placeholders and succeeds", async () => {
		const fake = translator((en, call) => {
			if (en === "Press {0} to stop." && call === 0) return "멈추려면 누르세요.";
			return TRANSLATIONS[en];
		});

		const result = await translateTemplates({
			templates: [template("stop", "Press {0} to stop.")],
			language: "한국어",
			complete: fake.complete,
			includeFixed: false,
		});

		expect(fake.count()).toBe(2);
		expect(result.entries.stop).toEqual({ en: "Press {0} to stop.", tr: "{0}를 눌러 멈추세요." });
		expect(result.failed).toEqual([]);
	});

	test("reports a key as failed when the retry still has bad placeholders", async () => {
		const fake = translator((en) =>
			en === "Press {0} to stop." ? "멈추려면 누르세요." : TRANSLATIONS[en],
		);

		const result = await translateTemplates({
			templates: [template("stop", "Press {0} to stop.")],
			language: "한국어",
			complete: fake.complete,
			includeFixed: false,
		});

		expect(fake.count()).toBe(2);
		expect(result.entries.stop).toBeUndefined();
		expect(result.failed).toEqual(["stop"]);
	});

	test("retries missing keys and keeps the successful ones", async () => {
		const fake = translator((en, call) => {
			if (en === "Hello" && call === 0) return undefined;
			return TRANSLATIONS[en];
		});

		const result = await translateTemplates({
			templates: [template("hello", "Hello"), template("run", "Run {0} then {1}.")],
			language: "한국어",
			complete: fake.complete,
			includeFixed: false,
			batchSize: 10,
		});

		expect(fake.count()).toBe(2);
		expect(result.entries.hello).toEqual({ en: "Hello", tr: "안녕하세요" });
		expect(result.entries.run).toEqual({ en: "Run {0} then {1}.", tr: "{0} 실행 후 {1}." });
		expect(result.failed).toEqual([]);
	});

	test("rejects empty, multiline, and non-string translations", async () => {
		const complete: Complete = async (_system, user) => {
			const items = JSON.parse(user) as Record<string, string>;
			const reply: Record<string, unknown> = {};
			for (const [key, en] of Object.entries(items)) {
				if (en === "Hello") reply[key] = "";
				else if (en === "Run {0} then {1}.") reply[key] = "a\nb";
				else reply[key] = 42;
			}
			return JSON.stringify(reply);
		};

		const result = await translateTemplates({
			templates: [
				template("hello", "Hello"),
				template("run", "Run {0} then {1}."),
				template("number", "Number"),
			],
			language: "한국어",
			complete,
			includeFixed: false,
		});

		expect(result.entries).toEqual({});
		expect(result.failed).toEqual(["hello", "number", "run"]);
	});

	test("marks everything failed on a non-JSON reply", async () => {
		const complete: Complete = async () => "sorry, I cannot do that";

		const result = await translateTemplates({
			templates: [template("hello", "Hello")],
			language: "한국어",
			complete,
			includeFixed: false,
		});

		expect(result.entries).toEqual({});
		expect(result.failed).toEqual(["hello"]);
	});

	test("batches by batchSize and reports progress to total", async () => {
		const templates = ["a", "b", "c", "d", "e"].map((id) => template(id, `Tip ${id}`));
		const fake = translator((en) => `번역 ${en}`);
		const progress: Array<[number, number]> = [];

		const result = await translateTemplates({
			templates,
			language: "한국어",
			complete: fake.complete,
			includeFixed: true,
			batchSize: 2,
			onProgress: (done, total) => progress.push([done, total]),
		});

		expect(fake.count()).toBe(4);
		expect(result.failed).toEqual([]);
		expect(Object.keys(result.entries)).toEqual(["a", "b", "c", "d", "e"]);
		expect(progress.at(-1)).toEqual([7, 7]);
	});

	test("aborts before calling complete when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fake = translator();

		let error: unknown;
		try {
			await translateTemplates({
				templates: [template("hello", "Hello")],
				language: "한국어",
				complete: fake.complete,
				includeFixed: false,
				signal: controller.signal,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("AbortError");
		expect(fake.count()).toBe(0);
	});

	test("aborts while complete is still pending", async () => {
		const controller = new AbortController();
		let release: (() => void) | undefined;
		const complete: Complete = () =>
			new Promise((resolve) => {
				release = () => resolve(JSON.stringify({ hello: "안녕하세요" }));
			});

		const pending = translateTemplates({
			templates: [template("hello", "Hello")],
			language: "한국어",
			complete,
			includeFixed: false,
			signal: controller.signal,
		});

		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		release?.();
	});

	test("aborts instead of returning partial results", async () => {
		const controller = new AbortController();
		const complete: Complete = async () => {
			controller.abort();
			return JSON.stringify({ hello: "안녕하세요" });
		};

		await expect(
			translateTemplates({
				templates: [template("hello", "Hello")],
				language: "한국어",
				complete,
				includeFixed: false,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
