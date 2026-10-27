import { POINTER_FORMS, PREFIX_EN } from "./extract";

export type Entry = { en: string; tr: string };
export type Table = { prefix: string; pointer: string; entries: Record<string, Entry> };
export type Matcher = { translateText(text: string): string };

const SGR_SOURCE = "\\x1b\\[[0-9;]*m";
const SGR_ANY = new RegExp(SGR_SOURCE);
const SGR_EDGES = new RegExp(`^((?:${SGR_SOURCE})*)([\\s\\S]*?)((?:${SGR_SOURCE})*)$`);
const PLACEHOLDER = /\{(\d+)\}/g;

export function placeholders(s: string): string[] {
  return (s.match(/\{\d+\}/g) ?? []).sort();
}

function samePlaceholders(a: string, b: string): boolean {
  const left = placeholders(a);
  const right = placeholders(b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type SlotPattern = { regex: RegExp; tr: string };

function compileSlotted(en: string, tr: string): SlotPattern {
  let source = "";
  let last = 0;
  PLACEHOLDER.lastIndex = 0;
  for (const m of en.matchAll(PLACEHOLDER)) {
    const at = m.index;
    source += escapeRegExp(en.slice(last, at)) + "(.+?)";
    last = at + m[0].length;
  }
  source += escapeRegExp(en.slice(last));
  return { regex: new RegExp(`^${source}$`), tr };
}

function fillSlots(tr: string, captures: string[]): string {
  return tr.replace(PLACEHOLDER, (token, index: string) => {
    const value = captures[Number(index)];
    return value === undefined ? token : value;
  });
}

export function createMatcher(table: Table): Matcher {
  const exact = new Map<string, string>();
  const slotted: SlotPattern[] = [];
  const seen = new Set<string>();

  for (const entry of Object.values(table.entries)) {
    if (seen.has(entry.en)) continue;
    if (!samePlaceholders(entry.en, entry.tr)) continue;
    seen.add(entry.en);
    const slots = placeholders(entry.en);
    if (slots.length === 0) exact.set(entry.en, entry.tr);
    else slotted.push(compileSlotted(entry.en, entry.tr));
  }

  const translateLine = (line: string): string => {
    if (POINTER_FORMS.includes(line)) return table.pointer;

    if (line.startsWith(PREFIX_EN)) {
      const body = line.slice(PREFIX_EN.length);
      const hit = exact.get(body);
      if (hit !== undefined) return `${table.prefix}${hit}`;
      for (const candidate of slotted) {
        const m = candidate.regex.exec(body);
        if (m) return `${table.prefix}${fillSlots(candidate.tr, m.slice(1))}`;
      }
    }

    return line;
  };

  return {
    translateText(text: string): string {
      const edge = SGR_EDGES.exec(text);
      if (!edge) return text;
      const prefix = edge[1];
      const plain = edge[2];
      const suffix = edge[3];
      if (SGR_ANY.test(plain)) return text;

      const out = prefix + plain.split("\n").map(translateLine).join("\n") + suffix;
      return out === text ? text : out;
    },
  };
}
