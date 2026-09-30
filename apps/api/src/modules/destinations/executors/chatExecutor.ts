import { getSystemSettings } from "../../settings/systemSettings.js";
import type { ChatChannelConfig } from "../types.js";
import { postJson, type HttpPostDeps } from "./httpPost.js";
import { slackPayload, summarize, teamsPayload } from "./integrationMessage.js";
import type { DestinationExecutor } from "./types.js";

/** Phase 19: a formatted message to a Slack or Microsoft Teams channel through its incoming-webhook URL. */
export function createChatExecutor(kind: "slack" | "teams", deps: HttpPostDeps = {}): DestinationExecutor {
  return {
    channelType: kind,
    execute: async (ctx) => {
      const config = ctx.channel.config as ChatChannelConfig;
      const summary = summarize(ctx, (await getSystemSettings()).appBaseUrl);
      const { outcome } = await postJson({ url: config.url, body: kind === "slack" ? slackPayload(summary) : teamsPayload(summary) }, deps);
      return outcome;
    },
  };
}

export const slackExecutor = createChatExecutor("slack");
export const teamsExecutor = createChatExecutor("teams");
