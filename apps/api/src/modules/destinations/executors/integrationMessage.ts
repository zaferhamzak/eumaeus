import { describeAnalysis } from "./forwardMessage.js";
import type { ExecutionContext } from "./types.js";

/** What every chat / ticket integration says about an email (Phase 19). All values here come from the email and are untrusted text. */
export interface IntegrationSummary {
  subject: string;
  from: string;
  destination: string;
  jev: string | null;
  link: string;
}

export function summarize(ctx: ExecutionContext, appBaseUrl: string): IntegrationSummary {
  const jev = ctx.analysis ? describeAnalysis(ctx.analysis.signals)[0]?.replace(/^Jev analysis: /, "") ?? null : null;
  return {
    subject: (ctx.email.subject || "(no subject)").replace(/[\r\n]+/g, " ").slice(0, 250),
    from: ctx.email.fromAddress,
    destination: ctx.routing.destinationRef,
    jev,
    link: `${appBaseUrl.replace(/\/$/, "")}/emails/${ctx.email.id}`,
  };
}

/** Slack mrkdwn: & < > are the control characters (they build links and @mentions like <!channel>). */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slackPayload(s: IntegrationSummary) {
  return {
    text: `New email for ${slackEscape(s.destination)}: ${slackEscape(s.subject)} (from ${slackEscape(s.from)})`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${slackEscape(s.subject)}*\nFrom ${slackEscape(s.from)}` } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `${s.jev ? `Jev: ${slackEscape(s.jev)} · ` : ""}Routed to ${slackEscape(s.destination)} · <${s.link}|Open in Eumaeus>` }],
      },
    ],
  };
}

/** Teams renders a subset of Markdown in TextBlocks; neutralize it so a subject can't restyle the card or add links. */
export function teamsEscape(text: string): string {
  return text.replace(/([\\*_`[\]()#>~|-])/g, "\\$1");
}

export function teamsPayload(s: IntegrationSummary) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: teamsEscape(s.subject), weight: "Bolder", wrap: true },
            { type: "TextBlock", text: `From ${teamsEscape(s.from)}`, isSubtle: true, wrap: true, spacing: "None" },
            {
              type: "FactSet",
              facts: [{ title: "Routed to", value: teamsEscape(s.destination) }, ...(s.jev ? [{ title: "Jev", value: teamsEscape(s.jev) }] : [])],
            },
          ],
          actions: [{ type: "Action.OpenUrl", title: "Open in Eumaeus", url: s.link }],
        },
      },
    ],
  };
}

/** Plain-text body for a ticket: the facts, an excerpt of the email, and the link back. */
export function ticketText(s: IntegrationSummary, receivedAt: Date, textBody: string | null): string {
  const excerpt = (textBody ?? "").trim().slice(0, 2000);
  return [
    `From: ${s.from}`,
    `Received: ${receivedAt.toUTCString()}`,
    ...(s.jev ? [`Jev: ${s.jev}`] : []),
    "",
    excerpt || "(no text body)",
    ...(textBody && textBody.trim().length > 2000 ? ["…"] : []),
    "",
    `Open in Eumaeus: ${s.link}`,
  ].join("\n");
}
