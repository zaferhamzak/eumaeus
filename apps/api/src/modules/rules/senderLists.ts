/**
 * Allow / block list matching (Phase 16). Pure — shared by the live engine and
 * the simulator through decideRouting().
 *
 * A pattern is a full address ("ceo@acme.com") or a domain ("@acme.com"),
 * stored lowercase. A domain pattern also matches its subdomains
 * ("@acme.com" matches "x@mail.acme.com"). When several entries match, the
 * most specific wins: an exact address beats a domain, a longer domain beats
 * a shorter one; on an exact tie "allow" wins, so a VIP is never blocked by
 * accident.
 */
export type SenderListKind = "allow" | "block";

export interface SenderListEntryForDecision {
  id: string;
  kind: SenderListKind;
  pattern: string;
}

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const DOMAIN = /^@(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lowercases and accepts "acme.com" as "@acme.com". Returns null for anything that isn't an address or a domain. */
export function normalizeSenderPattern(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (ADDRESS.test(value)) return value;
  const domain = value.startsWith("@") ? value : `@${value}`;
  return DOMAIN.test(domain) ? domain : null;
}

export function matchSenderList(entries: SenderListEntryForDecision[], fromAddress: string): SenderListEntryForDecision | null {
  const address = fromAddress.trim().toLowerCase();
  const domain = address.split("@")[1] ?? "";
  let best: { entry: SenderListEntryForDecision; score: number } | null = null;
  for (const entry of entries) {
    let score: number;
    if (!entry.pattern.startsWith("@")) {
      if (entry.pattern !== address) continue;
      score = 10_000; // exact address: always the most specific
    } else {
      const d = entry.pattern.slice(1);
      if (domain !== d && !domain.endsWith(`.${d}`)) continue;
      score = d.length;
    }
    const better = !best || score > best.score || (score === best.score && entry.kind === "allow" && best.entry.kind === "block");
    if (better) best = { entry, score };
  }
  return best?.entry ?? null;
}
