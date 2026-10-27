import { describe, expect, test } from "bun:test";
import { createMatcher, placeholders, type Table } from "../src/match";

const POINTER_EN =
  "↳ Want the full story on any tip? Ask about it: the give-me-tips skill has the tour.";
const POINTER_EN_LEGACY =
  "↳ Want the full story on any tip? Ask about it — the give-me-tips skill has the tour.";
const POINTER_TR = "↳ 팁의 전체 이야기가 궁금한가요? 물어보세요 — give-me-tips 스킬에 안내가 있습니다.";

function table(entries: Table["entries"], prefix = "팁: ", pointer = POINTER_TR): Table {
  return { prefix, pointer, entries };
}

describe("placeholders", () => {
  test("returns sorted tokens and keeps duplicates", () => {
    expect(placeholders("a {1} b {0} {1}")).toEqual(["{0}", "{1}", "{1}"]);
    expect(placeholders("no slots")).toEqual([]);
  });
});

describe("createMatcher", () => {
  test("translates a slotless tip with the prefix", () => {
    const matcher = createMatcher(table({ hello: { en: "hello there", tr: "안녕하세요" } }));
    expect(matcher.translateText("Tip: hello there")).toBe("팁: 안녕하세요");
  });

  test("translates one slot", () => {
    const matcher = createMatcher(
      table({ stop: { en: "Press {0} to stop.", tr: "{0}를 눌러 멈추세요." } }),
    );
    expect(matcher.translateText("Tip: Press Ctrl+C to stop.")).toBe("팁: Ctrl+C를 눌러 멈추세요.");
  });

  test("translates two slots in order", () => {
    const matcher = createMatcher(
      table({ two: { en: "Run {0} then {1}.", tr: "{0} 실행 후 {1}." } }),
    );
    expect(matcher.translateText("Tip: Run /a then /b.")).toBe("팁: /a 실행 후 /b.");
  });

  test("translates the pointer line", () => {
    const matcher = createMatcher(table({}));
    expect(matcher.translateText(POINTER_EN)).toBe(POINTER_TR);
  });

  test("translates the pre-5.1.45 em dash pointer line", () => {
    const matcher = createMatcher(table({}));
    expect(matcher.translateText(POINTER_EN_LEGACY)).toBe(POINTER_TR);
  });

  test("translates a two-line tip plus pointer inside ANSI codes", () => {
    const matcher = createMatcher(table({ stop: { en: "Press {0} to stop.", tr: "{0} 중지." } }));
    const input = `\x1b[2mTip: Press Esc to stop.\n${POINTER_EN}\x1b[39m`;
    expect(matcher.translateText(input)).toBe(`\x1b[2m팁: Esc 중지.\n${POINTER_TR}\x1b[39m`);
  });

  test("keeps ANSI wrapping when only one side has codes", () => {
    const matcher = createMatcher(table({ hi: { en: "hi", tr: "안녕" } }));
    expect(matcher.translateText("\x1b[2mTip: hi")).toBe("\x1b[2m팁: 안녕");
    expect(matcher.translateText("Tip: hi\x1b[0m")).toBe("팁: 안녕\x1b[0m");
  });

  test("returns input unchanged when ANSI appears inside the plain text", () => {
    const matcher = createMatcher(table({ hi: { en: "hi", tr: "안녕" } }));
    const input = "\x1b[2mTip: hi \x1b[31mthere\x1b[0m";
    expect(matcher.translateText(input)).toBe(input);
  });

  test("leaves unmatched lines and untranslated text unchanged", () => {
    const matcher = createMatcher(table({ hi: { en: "hi", tr: "안녕" } }));
    const input = "Tip: hi\nTip: unknown\nplain text";
    expect(matcher.translateText(input)).toBe("팁: 안녕\nTip: unknown\nplain text");
    expect(matcher.translateText("hello")).toBe("hello");
  });

  test("ignores an entry whose translation has different placeholders", () => {
    const matcher = createMatcher(
      table({
        missing: { en: "Press {0} now.", tr: "지금 누르세요." },
        extra: { en: "Press now.", tr: "{0} 지금 누르세요." },
      }),
    );
    expect(matcher.translateText("Tip: Press Enter now.")).toBe("Tip: Press Enter now.");
    expect(matcher.translateText("Tip: Press now.")).toBe("Tip: Press now.");
  });

  test("matches English containing regex special characters literally", () => {
    const matcher = createMatcher(
      table({
        special: {
          en: 'Use "x" (really)? a+b. [ok] — {0}',
          tr: '"{0}"을 쓰세요 (정말)? a+b. [ok]',
        },
      }),
    );
    expect(matcher.translateText('Tip: Use "x" (really)? a+b. [ok] — /go')).toBe(
      '팁: "/go"을 쓰세요 (정말)? a+b. [ok]',
    );
    expect(matcher.translateText("Tip: Use x really a+b [ok] — /go")).toBe(
      "Tip: Use x really a+b [ok] — /go",
    );
  });

  test("requires the full line to match, not a substring", () => {
    const matcher = createMatcher(table({ hi: { en: "hi", tr: "안녕" } }));
    expect(matcher.translateText("Tip: hi there")).toBe("Tip: hi there");
  });

  test("returns the same input value when nothing changed", () => {
    const matcher = createMatcher(table({}));
    const input = "no tip here";
    expect(matcher.translateText(input)).toBe(input);
  });
});
