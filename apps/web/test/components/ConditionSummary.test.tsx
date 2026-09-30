import { describe, expect, it } from "vitest";
import { conditionToText } from "@/components/rules/ConditionSummary";
import type { ConditionNode } from "@/types/api";

describe("conditionToText — rule condition readable rendering (§16/§17)", () => {
  it("renders a leaf condition", () => {
    const node: ConditionNode = { field: "sender.domain", op: "==", value: "example.com" };
    expect(conditionToText(node)).toBe("sender.domain == example.com");
  });

  it("renders an AND group", () => {
    const node: ConditionNode = {
      op: "AND",
      children: [
        { field: "sender.domain", op: "==", value: "example.com" },
        { field: "answers.is_business_opportunity", op: ">=", value: 0.8 },
      ],
    };
    expect(conditionToText(node)).toBe("(sender.domain == example.com AND answers.is_business_opportunity >= 0.8)");
  });

  it("renders a NOT wrapper", () => {
    const node: ConditionNode = { op: "NOT", child: { field: "has_attachment", op: "==", value: true } };
    expect(conditionToText(node)).toBe("NOT (has_attachment == true)");
  });

  it("renders an array value ('in' operator) readably", () => {
    const node: ConditionNode = { field: "answers.category", op: "in", value: ["spam", "phishing"] };
    expect(conditionToText(node)).toBe("answers.category in [spam, phishing]");
  });

  it("never invents an operator not present in the tree — renders exactly the op given", () => {
    const node: ConditionNode = { field: "subject", op: "contains", value: "invoice" };
    expect(conditionToText(node)).toContain("contains");
  });
});
