import { evaluateCondition, type ConditionNode, type EvaluationTrace } from "./conditions.js";
import { buildEvaluationContext, extractNoul, type EmailForEvaluation } from "./evaluationContext.js";
import { evaluateRuleGraph, type GraphNodeForEvaluation, type GraphStep } from "../rule-graphs/evaluateGraph.js";
import { matchSenderList, type SenderListEntryForDecision } from "./senderLists.js";

/**
 * The routing decision as a pure function of its inputs (Phase 14). The live
 * engine (evaluateRulesForEmail.ts) loads the inputs, calls this, and writes
 * the outcome; the simulator (simulateRouting.ts) calls the same function
 * with a draft rule or graph swapped in and writes nothing. One function, so
 * a simulation can't drift from what the engine would really do.
 *
 * Order:
 *   0. the sender is on the allow / block list  -> sender_allowed / sender_blocked (Phase 16)
 *   1. no successful analysis                  -> missing_analysis
 *   2. Jev's human_review_required >= threshold -> human_review_forced
 *   3. an enabled graph assigned to the mailbox -> the graph decides
 *   4. flat rules, priority ascending, first match wins
 *   5. nothing matched                          -> unmatched
 */
export interface RoutingPolicy {
  humanReviewSignalEnabled: boolean;
  humanReviewSignalThreshold: number;
  /** Phase 16: where blocked senders' mail goes. null = Human Review. */
  blockDestinationRef?: string | null;
}

export interface RuleForDecision {
  id: string;
  version: number;
  name: string;
  priority: number;
  conditions: unknown;
  destinationRef: string;
}

/** An enabled graph assigned to the email's mailbox. `version` null = the graph has no active version. */
export interface GraphForDecision {
  id: string;
  name: string;
  version: { version: number; rootNodeKey: string; nodes: GraphNodeForEvaluation[] } | null;
}

export interface DecideRoutingInput {
  email: EmailForEvaluation;
  /** Answers of the latest successful AnalysisResult, or null when there is none. */
  answers: Record<string, unknown> | null;
  policy: RoutingPolicy;
  graph: GraphForDecision | null;
  /** Active rules; sorted here, so callers may pass them in any order. */
  rules: RuleForDecision[];
  /** Phase 16: the organization's allow / block list. */
  senderList?: SenderListEntryForDecision[];
}

export interface RuleEvaluationStep {
  rule: RuleForDecision;
  trace: EvaluationTrace;
}

export type RoutingOutcome =
  | { kind: "sender_allowed"; entry: SenderListEntryForDecision }
  | { kind: "sender_blocked"; entry: SenderListEntryForDecision; destinationRef: string }
  | { kind: "missing_analysis" }
  | { kind: "human_review_forced"; signal: number; threshold: number }
  | { kind: "graph_routed"; graph: GraphForDecision; graphVersion: number; destinationRef: string; path: GraphStep[] }
  | { kind: "graph_invalid"; graph: GraphForDecision; graphVersion: number | null; reason: string; path: GraphStep[] }
  | { kind: "rule_matched"; rule: RuleForDecision; evaluations: RuleEvaluationStep[] }
  | { kind: "unmatched"; evaluations: RuleEvaluationStep[] };

export function decideRouting(input: DecideRoutingInput): RoutingOutcome {
  // Lists come first and need no analysis: a VIP stays untouched and a
  // blocked sender is handled even when Jev couldn't analyze the email.
  const listed = matchSenderList(input.senderList ?? [], input.email.fromAddress);
  if (listed?.kind === "allow") return { kind: "sender_allowed", entry: listed };
  if (listed?.kind === "block") return { kind: "sender_blocked", entry: listed, destinationRef: input.policy.blockDestinationRef || "human_review" };

  if (!input.answers) return { kind: "missing_analysis" };

  const signal = extractNoul(input.answers.human_review_required);
  if (input.policy.humanReviewSignalEnabled && signal !== undefined && signal >= input.policy.humanReviewSignalThreshold) {
    return { kind: "human_review_forced", signal, threshold: input.policy.humanReviewSignalThreshold };
  }

  const ctx = buildEvaluationContext(input.email, input.answers);

  if (input.graph) {
    const { graph } = input;
    if (!graph.version) return { kind: "graph_invalid", graph, graphVersion: null, reason: "graph has no active version", path: [] };
    const result = evaluateRuleGraph(graph.version.rootNodeKey, graph.version.nodes, ctx);
    return result.status === "routed"
      ? { kind: "graph_routed", graph, graphVersion: graph.version.version, destinationRef: result.destinationRef, path: result.path }
      : { kind: "graph_invalid", graph, graphVersion: graph.version.version, reason: result.reason, path: result.path };
  }

  const evaluations: RuleEvaluationStep[] = [];
  for (const rule of [...input.rules].sort((a, b) => a.priority - b.priority)) {
    const trace = evaluateCondition(rule.conditions as ConditionNode, ctx);
    evaluations.push({ rule, trace });
    if (trace.matched) return { kind: "rule_matched", rule, evaluations }; // first match wins
  }
  return { kind: "unmatched", evaluations };
}
