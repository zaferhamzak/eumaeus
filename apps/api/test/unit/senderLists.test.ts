import { describe, expect, it } from "vitest";
import { matchSenderList, normalizeSenderPattern, type SenderListEntryForDecision } from "../../src/modules/rules/senderLists.js";

const e = (id: string, kind: "allow" | "block", pattern: string): SenderListEntryForDecision => ({ id, kind, pattern });

describe("normalizeSenderPattern", () => {
  it.each([
    ["CEO@Acme.com", "ceo@acme.com"],
    ["acme.com", "@acme.com"],
    [" @Acme.COM ", "@acme.com"],
    ["mail.acme.com.tr", "@mail.acme.com.tr"],
  ])("%s -> %s", (input, out) => expect(normalizeSenderPattern(input)).toBe(out));

  it.each(["", "not a domain", "@", "x@", "acme"])("rejects %j", (input) => expect(normalizeSenderPattern(input)).toBeNull());
});

describe("matchSenderList", () => {
  it("matches an exact address, a domain and its subdomains — not look-alikes", () => {
    const list = [e("a", "block", "@acme.com")];
    expect(matchSenderList(list, "x@acme.com")?.id).toBe("a");
    expect(matchSenderList(list, "x@mail.acme.com")?.id).toBe("a");
    expect(matchSenderList(list, "x@notacme.com")).toBeNull();
    expect(matchSenderList(list, "x@acme.com.evil.test")).toBeNull();
  });

  it("the most specific entry wins; on a tie, allow wins", () => {
    const list = [e("dom-block", "block", "@acme.com"), e("addr-allow", "allow", "ceo@acme.com"), e("sub-allow", "allow", "@sales.acme.com")];
    expect(matchSenderList(list, "CEO@acme.com")?.id).toBe("addr-allow");
    expect(matchSenderList(list, "x@sales.acme.com")?.id).toBe("sub-allow");
    expect(matchSenderList(list, "x@acme.com")?.id).toBe("dom-block");
    expect(matchSenderList([e("b", "block", "@acme.com"), e("a", "allow", "@acme.com")], "x@acme.com")?.id).toBe("a");
  });
});
