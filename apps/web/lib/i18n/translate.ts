import type { ReactNode } from "react";
import { Fragment, createElement } from "react";
import { MESSAGES, type MessageKey, type Namespace } from "./messages";
import type { Locale } from "./locales";

export type Vars = Record<string, string | number>;

/**
 * Looks a key up in the locale, falling back to English, then to the key
 * itself (so a missing string is visible, never blank).
 *
 *   {name}        replaced by vars.name
 *   plurals       when vars.count is a number and "<key>_one" / "<key>_other"
 *                 exist, the form Intl.PluralRules picks is used (Turkish
 *                 uses "other" for everything above one).
 */
export function lookup(locale: Locale, key: string, vars?: Vars): string {
  const dot = key.indexOf(".");
  const ns = key.slice(0, dot) as Namespace;
  const k = key.slice(dot + 1);
  const pick = (loc: Locale): string | undefined => {
    const table = MESSAGES[loc][ns];
    if (!table) return undefined;
    if (vars && typeof vars.count === "number") {
      const form = new Intl.PluralRules(loc).select(vars.count);
      const plural = table[`${k}_${form}`] ?? table[`${k}_other`];
      if (plural !== undefined) return plural;
    }
    return table[k];
  };
  const template = pick(locale) ?? pick("en") ?? key;
  return vars ? template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : template;
}

export type Translate = ((key: MessageKey, vars?: Vars) => string) & {
  /**
   * For strings with markup: "<b>{n}</b> emails, see <link>Rules</link>" with
   * { b: (text) => <b>{text}</b>, link: (text) => <Link …>{text}</Link> }.
   * Tags don't nest; text outside tags is plain.
   */
  rich: (key: MessageKey, tags: Record<string, (chunk: string) => ReactNode>, vars?: Vars) => ReactNode;
};

export function makeTranslate(locale: Locale): Translate {
  const t = ((key: MessageKey, vars?: Vars) => lookup(locale, key, vars)) as Translate;
  t.rich = (key, tags, vars) => {
    const text = lookup(locale, key, vars);
    const parts: ReactNode[] = [];
    const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let last = 0;
    let match: RegExpExecArray | null;
    let i = 0;
    while ((match = re.exec(text))) {
      if (match.index > last) parts.push(text.slice(last, match.index));
      const render = tags[match[1]!];
      parts.push(createElement(Fragment, { key: i++ }, render ? render(match[2]!) : match[2]));
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return createElement(Fragment, null, ...parts);
  };
  return t;
}
