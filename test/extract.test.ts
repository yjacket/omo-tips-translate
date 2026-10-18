import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	POINTER_EN,
	PREFIX_EN,
	extractTemplates,
	findCatalogFiles,
	loadTemplates,
	sourceHash,
} from "../src/extract";

const RUNTIME_PARENT = join(homedir(), ".omo", "agent", "runtime");

function hasBundle(root: string): boolean {
	return existsSync(join(root, "dist", "bundle"));
}

function newestRuntimeRoot(): string | null {
	try {
		const candidates = readdirSync(RUNTIME_PARENT, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(RUNTIME_PARENT, entry.name))
			.filter(hasBundle);
		candidates.sort((a, b) => {
			const mtime = statSync(b).mtimeMs - statSync(a).mtimeMs;
			return mtime !== 0 ? mtime : b.localeCompare(a);
		});
		return candidates[0] ?? null;
	} catch {
		return null;
	}
}

const envRuntimeRoot = process.env.OMO_TIPS_RUNTIME_ROOT?.trim();
const discoveredRuntimeRoot = envRuntimeRoot ? null : newestRuntimeRoot();
const RUNTIME_ROOT = envRuntimeRoot || discoveredRuntimeRoot;
const runtimeAvailable = RUNTIME_ROOT !== null && hasBundle(RUNTIME_ROOT);
const runtimeReason = envRuntimeRoot
	? `${envRuntimeRoot} (from OMO_TIPS_RUNTIME_ROOT) has no dist/bundle`
	: `no directory under ${RUNTIME_PARENT} contains dist/bundle`;

if (runtimeAvailable) {
	console.log(
		`[extract] real runtime root: ${RUNTIME_ROOT} (${envRuntimeRoot ? "OMO_TIPS_RUNTIME_ROOT" : `newest under ${RUNTIME_PARENT}`})`,
	);
} else {
	console.log(`[extract] real runtime test SKIPPED: ${runtimeReason}`);
}

test("exports the exact runtime prefix and pointer strings", () => {
	expect(PREFIX_EN).toBe("Tip: ");
	expect(POINTER_EN).toBe(
		"↳ Want the full story on any tip? Ask about it — the give-me-tips skill has the tour.",
	);
});

describe("extractTemplates", () => {
	test("reads minified chunk-style definitions", () => {
		const source =
			'var CLI_TIPS=[{id:"print-mode",bindings:[],render:()=>`${APP_NAME} -p "question" answers without the TUI, and piped stdin is merged into the prompt.`},{id:"tool-flags",bindings:[],render:()=>"Limit a run\'s tools with -t read,bash, or drop a few with -xt write,edit."}];';
		expect(extractTemplates(source)).toEqual([
			{
				id: "print-mode",
				en: '{0} -p "question" answers without the TUI, and piped stdin is merged into the prompt.',
				slots: 1,
			},
			{
				id: "tool-flags",
				en: "Limit a run's tools with -t read,bash, or drop a few with -xt write,edit.",
				slots: 0,
			},
		]);
	});

	test("reads unminified catalog-style definitions", () => {
		const source = `function stopChord() { return "Ctrl+Alt+Shift+Escape"; }
export const COMPUTER_TIPS = [
    {
        id: "computer.stop-chord",
        bindings: [],
        requiresCommand: "computer",
        render: () => \`Press \${stopChord()} at any moment to stop computer input. It stays stopped until you run /computer resume; the agent cannot resume it.\`,
    },
    {
        id: "computer.what-it-is",
        bindings: [],
        render: () => "Experimental: your agent can use native apps too: screenshots, windows, clicks and typing.",
    },
];`;
		const templates = extractTemplates(source);
		expect(templates).toHaveLength(2);
		expect(templates[0]).toEqual({
			id: "computer.stop-chord",
			en: "Press {0} at any moment to stop computer input. It stays stopped until you run /computer resume; the agent cannot resume it.",
			slots: 1,
		});
		expect(templates[1]?.slots).toBe(0);
	});

	test("numbers template expressions in order and skips nested strings and braces", () => {
		const source =
			'const TIPS=[{id:"nested",render:(keys)=>`${APP_NAME} ${a(`x${b}`)} ${keys({ c: "}" })} end`}];';
		expect(extractTemplates(source)).toEqual([
			{ id: "nested", en: "{0} {1} {2} end", slots: 3 },
		]);
	});

	test("decodes escapes without eval", () => {
		const source =
			'const TIPS=[{id:"esc",render:()=>"a\\nb\\t\\"q\\" \\u0041 \\x42"},{id:"tpl",render:()=>`c\\nd\\t\\`e\\` \\$ \\\\ \\u{1F600}`}];';
		expect(extractTemplates(source)).toEqual([
			{ id: "esc", en: 'a b\t"q" A B', slots: 0 },
			{ id: "tpl", en: "c d\t`e` $ \\ 😀", slots: 0 },
		]);
	});

	test("normalizes newlines and surrounding whitespace", () => {
		const source = `const TIPS=[{id:"multi",render:()=>\`
            First line
              second line
        \`}];`;
		expect(extractTemplates(source)).toEqual([
			{ id: "multi", en: "First line second line", slots: 0 },
		]);
	});

	test("skips concatenated and conditional render bodies", () => {
		const source =
			'const TIPS=[{id:"concat",render:()=>"a"+"b"},{id:"ternary",render:()=>x?"a":"b"},{id:"ok",render:()=>"fine"}];';
		expect(extractTemplates(source)).toEqual([{ id: "ok", en: "fine", slots: 0 }]);
	});

	test("skips tips whose source already contains numeric placeholders", () => {
		const source =
			'const TIPS=[{id:"explicit",render:()=>"Use {0} now"},{id:"escaped",render:()=>"Cost \\u007b0\\u007d"},{id:"mixed",render:()=>`Use ${APP_NAME} and \\u007b0\\u007d`},{id:"ok",render:()=>`Use ${APP_NAME}`}];';
		expect(extractTemplates(source)).toEqual([
			{ id: "ok", en: "Use {0}", slots: 1 },
		]);
	});

	test("dedupes by id, first wins", () => {
		const source =
			'const TIPS=[{id:"same",render:()=>"first"},{id:"same",render:()=>"second"},{id:"other",render:()=>"third"}];';
		expect(extractTemplates(source)).toEqual([
			{ id: "same", en: "first", slots: 0 },
			{ id: "other", en: "third", slots: 0 },
		]);
	});

	test("ignores id occurrences that are not followed by a render literal", () => {
		const source =
			'const x={id:"no-render",bindings:[]}; const TIPS=[{id:"yes",render:()=>"ok"}]; const y={id:"after",render:()=>1}; const TIPS2=[{id:"also",render:()=>"yes"}];';
		expect(extractTemplates(source)).toEqual([
			{ id: "yes", en: "ok", slots: 0 },
			{ id: "also", en: "yes", slots: 0 },
		]);
	});
});

describe("findCatalogFiles", () => {
	test("prefers chunk files containing _TIPS=[ and returns absolute paths", () => {
		const root = mkdtempSync(join(tmpdir(), "tips-extract-"));
		try {
			const chunks = join(root, "dist", "bundle", "chunks");
			const catalog = join(root, "dist", "modes", "interactive", "tips", "catalog");
			mkdirSync(chunks, { recursive: true });
			mkdirSync(catalog, { recursive: true });
			writeFileSync(join(chunks, "a.js"), "var CLI_TIPS=[{id:'a',render:()=>'a'}]");
			writeFileSync(join(chunks, "b.js"), "var OTHER=[1]");
			writeFileSync(join(catalog, "computer-tips.js"), "export const X=[];");
			expect(findCatalogFiles(root)).toEqual([join(chunks, "a.js")]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("falls back to catalog *-tips.js files", () => {
		const root = mkdtempSync(join(tmpdir(), "tips-extract-"));
		try {
			const catalog = join(root, "dist", "modes", "interactive", "tips", "catalog");
			mkdirSync(catalog, { recursive: true });
			writeFileSync(join(catalog, "computer-tips.js"), "export const X=[];");
			writeFileSync(join(catalog, "types.js"), "export const Y=[];");
			writeFileSync(join(catalog, "notes.txt"), "ignore");
			expect(findCatalogFiles(root)).toEqual([
				join(catalog, "computer-tips.js"),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns [] for a missing runtime root", () => {
		expect(findCatalogFiles(join(tmpdir(), "tips-extract-missing-root"))).toEqual([]);
	});
});

describe("loadTemplates reasoning-level notice", () => {
	test("reads the one-time notice from a bundle chunk", () => {
		const root = mkdtempSync(join(tmpdir(), "tips-extract-"));
		try {
			const chunks = join(root, "dist", "bundle", "chunks");
			mkdirSync(chunks, { recursive: true });
			writeFileSync(
				join(chunks, "notice.js"),
				'function f(){let key=options.keys("app.thinking.cycle");if(key)return{tipId:"reasoning-level-key",line:`Tip: ${key} changes the reasoning level`}}',
			);
			expect(loadTemplates(root).templates).toEqual([
				{ id: "reasoning-level-key", en: "{0} changes the reasoning level", slots: 1 },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("falls back to dist/modes/interactive/tips/reasoning-level-notice.js", () => {
		const root = mkdtempSync(join(tmpdir(), "tips-extract-"));
		try {
			const tips = join(root, "dist", "modes", "interactive", "tips");
			mkdirSync(tips, { recursive: true });
			writeFileSync(
				join(tips, "reasoning-level-notice.js"),
				'export const REASONING_LEVEL_TIP_ID = "reasoning-level-key";\nexport function f(key) { return `Tip: ${key} changes the reasoning level`; }\n',
			);
			expect(loadTemplates(root).templates).toEqual([
				{ id: "reasoning-level-key", en: "{0} changes the reasoning level", slots: 1 },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("omits the notice when the runtime has no such literal", () => {
		const root = mkdtempSync(join(tmpdir(), "tips-extract-"));
		try {
			const chunks = join(root, "dist", "bundle", "chunks");
			mkdirSync(chunks, { recursive: true });
			writeFileSync(join(chunks, "a.js"), 'var CLI_TIPS=[{id:"a",render:()=>"a"}];');
			expect(loadTemplates(root).templates).toEqual([{ id: "a", en: "a", slots: 0 }]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("sourceHash", () => {
	test("is order independent, id/en sensitive, and stable", () => {
		const a = { id: "a", en: "one", slots: 0 };
		const b = { id: "b", en: "two", slots: 0 };
		const forward = sourceHash([a, b]);
		expect(forward).toMatch(/^[0-9a-f]{64}$/);
		expect(sourceHash([b, a])).toBe(forward);
		expect(sourceHash([a, { ...b, en: "changed" }])).not.toBe(forward);
		expect(sourceHash([a, b])).toBe(forward);
	});
});

describe(
	runtimeAvailable
		? "loadTemplates against the real runtime (WILL RUN)"
		: "loadTemplates against the real runtime (SKIPPED: runtime not found)",
	() => {
		test("loads >= 50 templates and the exact computer.stop-chord string", () => {
			if (!runtimeAvailable || RUNTIME_ROOT === null) return;
			const started = performance.now();
			const result = loadTemplates(RUNTIME_ROOT);
			console.log(
				`[extract] real runtime test RAN: ${result.templates.length} templates from ${result.files.length} file(s) in ${Math.round(performance.now() - started)}ms`,
			);
			expect(result.files.length).toBeGreaterThan(0);
			expect(result.templates.length).toBeGreaterThanOrEqual(50);
			const stopChord = result.templates.find((t) => t.id === "computer.stop-chord");
			expect(stopChord).toEqual({
				id: "computer.stop-chord",
				en: "Press {0} at any moment to stop computer input. It stays stopped until you run /computer resume; the agent cannot resume it.",
				slots: 1,
			});
			expect(result.templates.find((t) => t.id === "reasoning-level-key")).toEqual({
				id: "reasoning-level-key",
				en: "{0} changes the reasoning level",
				slots: 1,
			});
		});
	},
);
