import { apiRequest } from "./client";
import type {
  ConditionNode,
  RuleGraphInput,
  SimulationResult,
} from "@/types/api";

export type SimulationTarget =
  | {
      type: "rule";
      rule: {
        name: string;
        priority: number;
        conditions: ConditionNode;
        destinationRef: string;
      };
      replaceRuleId?: string;
    }
  | { type: "graph"; graph: RuleGraphInput }
  | {
      type: "sender_entry";
      entry: { kind: "allow" | "block"; pattern: string };
    }
  | { type: "current" };

export interface SimulationScope {
  emailIds?: string[];
  mailboxConnectionIds?: string[];
  since?: string;
  limit?: number;
}

/** Read-only: runs the draft over past emails, changes nothing. */
export function simulate(target: SimulationTarget, scope: SimulationScope) {
  return apiRequest<SimulationResult>("/api/v1/simulations", {
    method: "POST",
    body: { target, scope },
  });
}
