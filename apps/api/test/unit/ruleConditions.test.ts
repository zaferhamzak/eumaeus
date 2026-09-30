import { describe, expect, it } from "vitest";
import { evaluateCondition, resolveField, type ConditionNode, type EvaluationContext } from "../../src/modules/rules/conditions.js";

function ctx(overrides?: Partial<EvaluationContext["email"]>, answers?: Record<string, unknown>): EvaluationContext {
  return {
    email: {
      fromAddress: "alice@example.com",
      toAddresses: ["bob@eumaeus.test"],
      subject: "Quarterly proposal",
      hasAttachments: false,
      attachmentFilenames: [],
      ...overrides,
    },
    answers: answers ?? {
      is_spam: { noul: 0.05 },
      is_business_opportunity: { noul: 0.9 },
      is_collaboration: { noul: 0.1 },
      is_customer_related: { noul: 0.85 },
      requires_response: { noul: 0.7 },
      human_review_required: { noul: 0.05 },
      category: { choice: "business_opportunity", probabilities: { business_opportunity: 0.9 }, confidence: 0.9 },
      urgency: { score: 2.4, legend: { "0": "low", "1": "medium", "2": "high", "3": "critical" }, probabilities: { "0": 0, "1": 0.1, "2": 0.6, "3": 0.3 }, confidence: 0.6 },
    },
  };
}

describe("resolveField", () => {
  it("resolves deterministic email fields", () => {
    const c = ctx();
    expect(resolveField("sender.address", c)).toBe("alice@example.com");
    expect(resolveField("sender.domain", c)).toBe("example.com");
    expect(resolveField("recipient.address", c)).toEqual(["bob@eumaeus.test"]);
    expect(resolveField("subject", c)).toBe("Quarterly proposal");
    expect(resolveField("has_attachment", c)).toBe(false);
  });

  it("resolves noul, choice, and score answers", () => {
    const c = ctx();
    expect(resolveField("answers.is_spam", c)).toBe(0.05);
    expect(resolveField("answers.category", c)).toBe("business_opportunity");
    expect(resolveField("answers.category.confidence", c)).toBe(0.9);
    expect(resolveField("answers.urgency", c)).toBe(2.4);
    expect(resolveField("answers.urgency.confidence", c)).toBe(0.6);
  });

  it("returns undefined for an unresolvable field rather than throwing", () => {
    const c = ctx();
    expect(resolveField("answers.does_not_exist", c)).toBeUndefined();
    expect(resolveField("not.a.real.field", c)).toBeUndefined();
  });
});

describe("evaluateCondition — leaves and operators", () => {
  it("matches a simple numeric threshold", () => {
    const node: ConditionNode = { field: "answers.is_business_opportunity", op: ">=", value: 0.8 };
    expect(evaluateCondition(node, ctx()).matched).toBe(true);
  });

  it("fails a numeric threshold that isn't met", () => {
    const node: ConditionNode = { field: "answers.is_business_opportunity", op: ">=", value: 0.95 };
    expect(evaluateCondition(node, ctx()).matched).toBe(false);
  });

  it("supports the == true / == false convenience form for noul fields, documented as a 0.5 threshold", () => {
    expect(evaluateCondition({ field: "answers.is_customer_related", op: "==", value: true }, ctx()).matched).toBe(true); // 0.85 >= 0.5
    expect(evaluateCondition({ field: "answers.is_collaboration", op: "==", value: true }, ctx()).matched).toBe(false); // 0.1 < 0.5
    expect(evaluateCondition({ field: "answers.is_collaboration", op: "==", value: false }, ctx()).matched).toBe(true);
  });

  it("matches an exact string equality on a choice field", () => {
    expect(evaluateCondition({ field: "answers.category", op: "==", value: "business_opportunity" }, ctx()).matched).toBe(true);
  });

  it("matches sender.domain equality", () => {
    expect(evaluateCondition({ field: "sender.domain", op: "==", value: "example.com" }, ctx()).matched).toBe(true);
  });

  it("matches subject with contains, case-insensitively", () => {
    expect(evaluateCondition({ field: "subject", op: "contains", value: "PROPOSAL" }, ctx()).matched).toBe(true);
    expect(evaluateCondition({ field: "subject", op: "contains", value: "invoice" }, ctx()).matched).toBe(false);
  });

  it("matches attachment.filename contains across the list", () => {
    const c = ctx({ hasAttachments: true, attachmentFilenames: ["invoice-2026.pdf", "readme.txt"] });
    expect(evaluateCondition({ field: "attachment.filename", op: "contains", value: "invoice" }, c).matched).toBe(true);
    expect(evaluateCondition({ field: "attachment.filename", op: "contains", value: "contract" }, c).matched).toBe(false);
  });

  it("matches 'in' against a list of allowed values", () => {
    expect(evaluateCondition({ field: "sender.domain", op: "in", value: ["example.com", "other.com"] }, ctx()).matched).toBe(true);
    expect(evaluateCondition({ field: "sender.domain", op: "in", value: ["other.com"] }, ctx()).matched).toBe(false);
  });

  it("a missing/unresolvable field never matches, regardless of operator", () => {
    expect(evaluateCondition({ field: "answers.does_not_exist", op: ">=", value: 0 }, ctx()).matched).toBe(false);
  });
});

describe("evaluateCondition — AND / OR / NOT / nesting", () => {
  it("AND requires every child to match", () => {
    const node: ConditionNode = {
      op: "AND",
      children: [
        { field: "answers.is_customer_related", op: "==", value: true },
        { field: "answers.requires_response", op: "==", value: true },
      ],
    };
    expect(evaluateCondition(node, ctx()).matched).toBe(true);

    const failing: ConditionNode = {
      op: "AND",
      children: [
        { field: "answers.is_customer_related", op: "==", value: true },
        { field: "answers.is_collaboration", op: "==", value: true }, // false
      ],
    };
    expect(evaluateCondition(failing, ctx()).matched).toBe(false);
  });

  it("OR requires at least one child to match", () => {
    const node: ConditionNode = {
      op: "OR",
      children: [
        { field: "answers.is_spam", op: "==", value: true }, // false (0.05)
        { field: "answers.is_business_opportunity", op: "==", value: true }, // true
      ],
    };
    expect(evaluateCondition(node, ctx()).matched).toBe(true);
  });

  it("NOT inverts its child", () => {
    const node: ConditionNode = { op: "NOT", child: { field: "answers.is_spam", op: "==", value: true } };
    expect(evaluateCondition(node, ctx()).matched).toBe(true);
  });

  it("evaluates a deeply nested combination deterministically", () => {
    // (is_business_opportunity AND urgency >= 2) OR (NOT is_spam AND sender.domain == "example.com")
    const node: ConditionNode = {
      op: "OR",
      children: [
        {
          op: "AND",
          children: [
            { field: "answers.is_business_opportunity", op: "==", value: true },
            { field: "answers.urgency", op: ">=", value: 2 },
          ],
        },
        {
          op: "AND",
          children: [
            { op: "NOT", child: { field: "answers.is_spam", op: "==", value: true } },
            { field: "sender.domain", op: "==", value: "example.com" },
          ],
        },
      ],
    };
    expect(evaluateCondition(node, ctx()).matched).toBe(true);
  });

  it("records a full leaf-by-leaf trace for explainability", () => {
    const node: ConditionNode = {
      op: "AND",
      children: [
        { field: "answers.is_customer_related", op: "==", value: true },
        { field: "answers.is_spam", op: "==", value: true },
      ],
    };
    const trace = evaluateCondition(node, ctx());
    expect(trace.matched).toBe(false);
    expect(trace.leaves).toHaveLength(2);
    expect(trace.leaves[0]).toMatchObject({ field: "answers.is_customer_related", result: true });
    expect(trace.leaves[1]).toMatchObject({ field: "answers.is_spam", result: false });
  });
});

describe("evaluateCondition — invalid usage fails safe", () => {
  it("a type-mismatched numeric operator does not match and does not throw out of evaluateCondition", () => {
    const node: ConditionNode = { field: "sender.domain", op: ">=", value: 5 }; // domain is a string
    const trace = evaluateCondition(node, ctx());
    expect(trace.matched).toBe(false);
    expect(trace.error).toBeDefined();
  });
});

/**
 * Regression for the real incident: an invoice rule written with AND where OR
 * was meant silently routed invoices elsewhere. Type checks can't catch that;
 * only counting what each form matches does.
 */
describe("AND vs OR regression — the same rule written two ways reaches different emails", () => {
  const emails = [
    { subject: "Fatura 2026/09", category: "invoice" },
    { subject: "Makbuzunuz", category: "invoice" },
    { subject: "Fatura hatırlatma", category: "other" },
    { subject: "Kampanya", category: "marketing" },
  ];
  const leaves = [
    { field: "answers.category", op: "==", value: "invoice" },
    { field: "subject", op: "contains", value: "fatura" },
  ] as const;
  const count = (op: "AND" | "OR") =>
    emails.filter((e) =>
      evaluateCondition({ op, children: [...leaves] } as ConditionNode, {
        email: { fromAddress: "billing@shop.test", toAddresses: [], subject: e.subject, hasAttachments: false, attachmentFilenames: [] },
        answers: { category: { choice: e.category, probabilities: {}, confidence: 0.9 } },
      }).matched,
    ).length;

  it("OR catches every invoice (3), AND only the one that is both (1)", () => {
    expect(count("OR")).toBe(3);
    expect(count("AND")).toBe(1);
    expect(count("OR")).not.toBe(count("AND"));
  });
});

/** Turkish casing: plain toLowerCase() broke "contains" for dotted/dotless i in uppercase subjects. */
describe("contains is Turkish-safe", () => {
  const match = (subject: string, value: string) => evaluateCondition({ field: "subject", op: "contains", value }, ctx({ subject })).matched;
  it("İ/ı/I compare as expected in both directions", () => {
    expect(match("İLK Instagram reklamlar makbuzunuz", "ilk")).toBe(true);
    expect(match("ŞİFRE SIFIRLAMA KODUNUZ", "sıfırlama")).toBe(true);
    expect(match("şifre sıfırlama", "SIFIRLAMA")).toBe(true);
    expect(match("Invoice ready", "invoice")).toBe(true);
    expect(match("Güvenlik uyarısı", "GÜVENLİK")).toBe(true);
    expect(match("Çağrı merkezi", "cagri")).toBe(false); // only i/ı are folded, not ç/ğ
  });
});
