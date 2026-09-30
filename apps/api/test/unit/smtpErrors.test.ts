import { describe, expect, it } from "vitest";
import { classifySmtpError } from "../../src/modules/destinations/executors/smtpErrors.js";

function smtpError(fields: { code?: string; command?: string; responseCode?: number }) {
  return Object.assign(new Error("smtp failure"), fields);
}

describe("classifySmtpError — never sent vs. maybe sent", () => {
  it.each([
    [{ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 }, "not_sent_permanent", "smtp_auth"],
    [{ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }, "not_sent_permanent", "smtp_rejected"],
    [{ code: "EMESSAGE", command: "DATA", responseCode: 554 }, "not_sent_permanent", "smtp_rejected"],
    [{ code: "EENVELOPE", command: "RCPT TO", responseCode: 451 }, "not_sent_retryable", "smtp_temporary"],
    [{ code: "ECONNECTION", command: "CONN" }, "not_sent_retryable", "connection"],
    [{ code: "ETIMEDOUT", command: "CONN" }, "not_sent_retryable", "connection"],
    [{ code: "EDNS" }, "not_sent_retryable", "connection"],
    [{ code: "ECONNREFUSED" }, "not_sent_retryable", "connection"],
    [{ code: "ETLS", command: "STARTTLS" }, "not_sent_retryable", "connection"],
    [{ code: "ECONNECTION", command: "DATA" }, "maybe_sent", "smtp_unknown_outcome"],
    [{ code: "ETIMEDOUT" }, "maybe_sent", "smtp_unknown_outcome"],
    [{}, "maybe_sent", "smtp_unknown_outcome"],
  ] as const)("%j → %s", (fields, kind, errorClass) => {
    const result = classifySmtpError(smtpError(fields));
    expect(result.kind).toBe(kind);
    expect(result.errorClass).toBe(errorClass);
  });
});
