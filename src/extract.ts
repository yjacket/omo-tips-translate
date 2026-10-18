import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export type TipTemplate = { id: string; en: string; slots: number };

export const POINTER_EN =
	"↳ Want the full story on any tip? Ask about it — the give-me-tips skill has the tour.";
export const PREFIX_EN = "Tip: ";

const NORMALIZE = /\s*\n\s*/g;
const EXPLICIT_SLOT = /\{\d+\}/;

type ParsedLiteral = {
	value: string;
	slots: number;
	end: number;
	explicitSlot: boolean;
};

function decodeEscape(src: string, index: number): { text: string; next: number } {
	// index points at the backslash.
	const ch = src[index + 1];
	if (ch === undefined) return { text: "", next: index + 1 };
	switch (ch) {
		case "n":
			return { text: "\n", next: index + 2 };
		case "r":
			return { text: "\r", next: index + 2 };
		case "t":
			return { text: "\t", next: index + 2 };
		case "b":
			return { text: "\b", next: index + 2 };
		case "f":
			return { text: "\f", next: index + 2 };
		case "v":
			return { text: "\v", next: index + 2 };
		case "0":
			return { text: "\0", next: index + 2 };
		case "\n":
			return { text: "", next: index + 2 };
		case "\r":
			return { text: "", next: src[index + 2] === "\n" ? index + 3 : index + 2 };
		case "x": {
			const hex = src.slice(index + 2, index + 4);
			if (/^[0-9a-fA-F]{2}$/.test(hex)) {
				return { text: String.fromCharCode(Number.parseInt(hex, 16)), next: index + 4 };
			}
			return { text: "x", next: index + 2 };
		}
		case "u": {
			if (src[index + 2] === "{") {
				const close = src.indexOf("}", index + 3);
				if (close !== -1) {
					const hex = src.slice(index + 3, close);
					if (/^[0-9a-fA-F]+$/.test(hex)) {
						const code = Number.parseInt(hex, 16);
						if (code <= 0x10ffff) {
							return { text: String.fromCodePoint(code), next: close + 1 };
						}
					}
				}
				return { text: "u", next: index + 2 };
			}
			const hex = src.slice(index + 2, index + 6);
			if (/^[0-9a-fA-F]{4}$/.test(hex)) {
				return { text: String.fromCharCode(Number.parseInt(hex, 16)), next: index + 6 };
			}
			return { text: "u", next: index + 2 };
		}
		default:
			return { text: ch, next: index + 2 };
	}
}

function skipQuoted(src: string, start: number): number {
	const quote = src[start];
	let i = start + 1;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === quote) return i + 1;
		i++;
	}
	return src.length;
}

function skipTemplate(src: string, start: number): number {
	let i = start + 1;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "`") return i + 1;
		if (ch === "$" && src[i + 1] === "{") {
			i = skipExpression(src, i + 2);
			continue;
		}
		i++;
	}
	return src.length;
}

function skipExpression(src: string, start: number): number {
	// start points just after "${".
	let depth = 1;
	let i = start;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '"' || ch === "'") {
			i = skipQuoted(src, i);
			continue;
		}
		if (ch === "`") {
			i = skipTemplate(src, i);
			continue;
		}
		if (ch === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i + 2);
			i = nl === -1 ? src.length : nl + 1;
			continue;
		}
		if (ch === "/" && src[i + 1] === "*") {
			const close = src.indexOf("*/", i + 2);
			i = close === -1 ? src.length : close + 2;
			continue;
		}
		if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
		i++;
	}
	return src.length;
}

function parseLiteral(src: string, start: number): ParsedLiteral | undefined {
	const quote = src[start];
	if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
	const template = quote === "`";
	let i = start + 1;
	let value = "";
	let plain = "";
	let slots = 0;

	while (i < src.length) {
		const ch = src[i];
		if (template && ch === "`") {
			return { value, slots, end: i + 1, explicitSlot: EXPLICIT_SLOT.test(plain) };
		}
		if (!template && ch === quote) {
			return { value, slots, end: i + 1, explicitSlot: EXPLICIT_SLOT.test(plain) };
		}
		if (!template && (ch === "\n" || ch === "\r")) return undefined;
		if (ch === "\\") {
			const decoded = decodeEscape(src, i);
			value += decoded.text;
			plain += decoded.text;
			i = decoded.next;
			continue;
		}
		if (template && ch === "$" && src[i + 1] === "{") {
			value += `{${slots}}`;
			slots++;
			i = skipExpression(src, i + 2);
			continue;
		}
		value += ch;
		plain += ch;
		i++;
	}
	return undefined;
}

function readString(src: string, start: number): { value: string; end: number } | undefined {
	const parsed = parseLiteral(src, start);
	if (!parsed) return undefined;
	return { value: parsed.value, end: parsed.end };
}

function hasIdBoundaryBefore(src: string, index: number): boolean {
	if (index === 0) return true;
	return !/[$\w]/.test(src[index - 1]);
}

/**
 * Parses tip definitions from a bundle chunk or a catalog module.
 * Dedupes by id; the first occurrence wins.
 */
export function extractTemplates(source: string): TipTemplate[] {
	const templates: TipTemplate[] = [];
	const seen = new Set<string>();
	let searchFrom = 0;

	while (searchFrom < source.length) {
		const idMatch = /\bid\s*:\s*/g;
		idMatch.lastIndex = searchFrom;
		const match = idMatch.exec(source);
		if (!match) break;
		const idIndex = match.index;
		const afterColon = idIndex + match[0].length;
		searchFrom = afterColon;
		if (!hasIdBoundaryBefore(source, idIndex)) continue;

		const idLiteral = readString(source, afterColon);
		if (!idLiteral || idLiteral.value.length === 0) continue;

		// The render must live in the same object, so bound the search to its
		// closing brace. This keeps huge bundles from being rescanned per id.
		const objectEnd = source.indexOf("}", idLiteral.end);
		if (objectEnd === -1) continue;
		const withinObject = source.slice(idLiteral.end, objectEnd).indexOf("render:");
		if (withinObject === -1) {
			searchFrom = idLiteral.end;
			continue;
		}
		const renderIndex = idLiteral.end + withinObject;

		const arrow = source.indexOf("=>", renderIndex);
		if (arrow === -1) continue;
		let literalStart = arrow + 2;
		while (literalStart < source.length && /\s/.test(source[literalStart])) literalStart++;

		const literal = parseLiteral(source, literalStart);
		if (!literal) {
			searchFrom = arrow + 2;
			continue;
		}

		let after = literal.end;
		while (after < source.length && (source[after] === " " || source[after] === "\t" || source[after] === "\r")) {
			after++;
		}
		const terminator = source[after];
		if (after < source.length && terminator !== "," && terminator !== "}" && terminator !== "\n") {
			searchFrom = literal.end;
			continue;
		}
		if (literal.explicitSlot) {
			searchFrom = literal.end;
			continue;
		}

		const en = literal.value.replace(NORMALIZE, " ").trim();
		if (!en || seen.has(idLiteral.value)) {
			searchFrom = literal.end;
			continue;
		}
		seen.add(idLiteral.value);
		templates.push({ id: idLiteral.value, en, slots: literal.slots });
		searchFrom = literal.end;
	}
	return templates;
}

function listJsFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".js"))
			.sort()
			.map((name) => resolve(dir, name));
	} catch {
		return [];
	}
}

export function findCatalogFiles(runtimeRoot: string): string[] {
	const chunkDir = resolve(runtimeRoot, "dist", "bundle", "chunks");
	const chunks = listJsFiles(chunkDir).filter((file) => {
		try {
			return readFileSync(file, "utf8").includes("_TIPS=[");
		} catch {
			return false;
		}
	});
	if (chunks.length > 0) return chunks;

	const catalogDir = resolve(runtimeRoot, "dist", "modes", "interactive", "tips", "catalog");
	return listJsFiles(catalogDir).filter((file) => /-tips\.js$/.test(file));
}

export function loadTemplates(runtimeRoot: string): { templates: TipTemplate[]; files: string[] } {
	const files = findCatalogFiles(runtimeRoot);
	const seen = new Set<string>();
	const templates: TipTemplate[] = [];
	for (const file of files) {
		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const template of extractTemplates(source)) {
			if (seen.has(template.id)) continue;
			seen.add(template.id);
			templates.push(template);
		}
	}
	return { templates, files };
}

export function sourceHash(templates: TipTemplate[]): string {
	const lines = templates
		.map((template) => `${template.id}\u0000${template.en}`)
		.sort();
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}

