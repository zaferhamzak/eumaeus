import { describe, expect, it } from "vitest";
import { validateJevResponse } from "../../src/modules/jev/response.js";
import { JevMalformedResponseError } from "../../src/modules/jev/errors.js";
import { DECISION_SCHEMA_V1 } from "../../src/modules/jev/schema.js";
import { buildValidJevResponseBody } from "../fixtures/jevFixtures.js";

describe("validateJevResponse — Decision Schema v1 validation/normalization", () => {
  it("accepts a well-formed response and normalizes it into typed, per-primitive answers", () => {
    const result = validateJevResponse(DECISION_SCHEMA_V1, buildValidJevResponseBody());

    expect(result.schemaVersion).toBe("v1");
    expect(result.jevModel).toBe("jev-1.13.0");
    expect(result.answers.is_spam).toEqual({ noul: 0.03 });
    expect(result.answers.category).toMatchObject({ choice: "business_opportunity" });
    expect(result.usage).toEqual({ inputTokens: 184, outputTokens: 0 });
  });

  it("rejects a response missing the top-level envelope fields", () => {
    expect(() => validateJevResponse(DECISION_SCHEMA_V1, { answers: {} })).toThrow(JevMalformedResponseError);
  });

  it("rejects a response missing an answer for a configured question", () => {
    const body = buildValidJevResponseBody();
    // @ts-expect-error - deliberately malformed for the test
    delete body.answers.urgency;
    expect(() => validateJevResponse(DECISION_SCHEMA_V1, body)).toThrow(/missing an answer for question "urgency"/);
  });

  it("rejects a noul answer with an out-of-range probability", () => {
    const body = buildValidJevResponseBody({ answers: { is_spam: { noul: 1.5 } } });
    expect(() => validateJevResponse(DECISION_SCHEMA_V1, body)).toThrow(JevMalformedResponseError);
  });

  it("rejects a noul answer with the wrong shape entirely (e.g. a choice-shaped answer)", () => {
    const body = buildValidJevResponseBody({ answers: { is_spam: { choice: "yes", probabilities: {}, confidence: 0.5 } } });
    expect(() => validateJevResponse(DECISION_SCHEMA_V1, body)).toThrow(/noul question "is_spam"/);
  });

  it("rejects a choice answer whose value is outside the configured criteria", () => {
    const body = buildValidJevResponseBody({
      answers: { category: { choice: "not_a_real_category", probabilities: { x: 1 }, confidence: 0.9 } },
    });
    expect(() => validateJevResponse(DECISION_SCHEMA_V1, body)).toThrow(/outside the configured criteria/);
  });

  it("rejects a score answer whose numeric value is outside the valid index range", () => {
    // urgency has 4 configured levels (indices 0-3) — 5 is out of range regardless
    // of it being a plausible-looking number.
    const body = buildValidJevResponseBody({
      answers: {
        urgency: { score: 5, legend: { "0": "low", "1": "medium", "2": "high", "3": "critical" }, probabilities: { "0": 1 }, confidence: 0.9 },
      },
    });
    expect(() => validateJevResponse(DECISION_SCHEMA_V1, body)).toThrow(/outside the valid range/);
  });

  it("rejects a score answer missing probabilities for a configured level index", () => {
    const body = buildValidJevResponseBody({
      answers: {
        urgency: {
          score: 1,
          legend: { "0": "low", "1": "medium", "2": "high", "3": "critical" },
          probabilities: { "0": 0.5, "1": 0.5 }, // missing indices "2" and "3"
          confidence: 0.5,
        },
      },
    });
    expect(() => validateJevResponse(DECISION_SCHEMA_V1, body)).toThrow(/missing probabilities for level index/);
  });

  it("rejects a score answer whose 'score' is a string instead of a number (this project's original, incorrect assumption)", () => {
    // Regression guard for the real discrepancy found during Phase 3 real-API
    // verification: score is NOT a discrete label like Choice's `choice` field.
    const body = buildValidJevResponseBody({
      answers: { urgency: { score: "medium", legend: {}, probabilities: { "0": 1 }, confidence: 0.9 } },
    });
    expect(() => validateJevResponse(DECISION_SCHEMA_V1, body)).toThrow(JevMalformedResponseError);
  });

  it("rejects a choice/score answer missing its confidence field", () => {
    const body = buildValidJevResponseBody({
      answers: { category: { choice: "business_opportunity", probabilities: { business_opportunity: 1 } } },
    });
    expect(() => validateJevResponse(DECISION_SCHEMA_V1, body)).toThrow(JevMalformedResponseError);
  });

  it("does not fabricate a top-level 'confidence' field that Jev never returned", () => {
    const result = validateJevResponse(DECISION_SCHEMA_V1, buildValidJevResponseBody());
    expect(result).not.toHaveProperty("confidence");
  });
});
