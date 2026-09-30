import { describe, expect, it } from "vitest";
import { en, tr } from "@/lib/i18n/messages";
import { lookup, makeTranslate } from "@/lib/i18n/translate";
import { localeFromAcceptLanguage } from "@/lib/i18n/locales";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort();

/** Phase 21: the two languages must stay in step — same keys, same {placeholders}, same <tags>. */
describe("i18n dictionaries", () => {
  for (const ns of Object.keys(en) as Array<keyof typeof en>) {
    it(`${ns}: Turkish has exactly the English keys, placeholders and tags`, () => {
      const e = en[ns] as Record<string, string>;
      const t = tr[ns];
      const enKeys = Object.keys(e).sort();
      const trKeys = Object.keys(t).sort();
      // Plural forms may differ (_one exists in English only), so compare base keys.
      const base = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, "");
      expect([...new Set(trKeys.map(base))]).toEqual([...new Set(enKeys.map(base))]);
      for (const k of trKeys) {
        const ref = e[k] ?? e[`${base(k)}_other`] ?? "";
        expect(placeholders(t[k]!), `${ns}.${k} placeholders`).toEqual(placeholders(ref));
        expect(tags(t[k]!), `${ns}.${k} tags`).toEqual(tags(ref));
        expect(t[k]!.trim(), `${ns}.${k} is empty`).not.toBe("");
      }
    });
  }
});

describe("translate", () => {
  it("interpolates, pluralizes and falls back", () => {
    expect(lookup("tr", "common.requestId", { id: "abc" })).toBe("İstek kimliği: abc");
    expect(lookup("tr", "common.nonexistent" as never)).toBe("common.nonexistent");
    expect(lookup("en", "auth.signInWith", { provider: "Google" })).toBe("Sign in with Google");
  });

  it("renders tags with rich()", () => {
    const t = makeTranslate("en");
    const html = renderToStaticMarkup(createElement("p", null, t.rich("auth.signInWith", { b: (c) => createElement("b", null, c) }, { provider: "X" })));
    expect(html).toBe("<p>Sign in with X</p>");
  });

  it("picks the language from Accept-Language", () => {
    expect(localeFromAcceptLanguage("tr-TR,tr;q=0.9,en;q=0.8")).toBe("tr");
    expect(localeFromAcceptLanguage("de-DE,en;q=0.5")).toBe("en");
    expect(localeFromAcceptLanguage("de-DE")).toBe("en");
    expect(localeFromAcceptLanguage(null)).toBe("en");
  });
});
