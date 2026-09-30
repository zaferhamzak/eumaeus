/**
 * Phase 21: every interface string, one flat JSON file per area and language
 * (messages/<locale>/<namespace>.json). Keys are "namespace.key"; the English
 * files define which keys exist (MessageKey is derived from them, so a typo is
 * a type error), and a test checks the Turkish files have exactly the same
 * keys and placeholders.
 */
import en_common from "@/messages/en/common.json";
import en_nav from "@/messages/en/nav.json";
import en_auth from "@/messages/en/auth.json";
import en_overview from "@/messages/en/overview.json";
import en_emails from "@/messages/en/emails.json";
import en_review from "@/messages/en/review.json";
import en_audit from "@/messages/en/audit.json";
import en_rules from "@/messages/en/rules.json";
import en_ruleGraphs from "@/messages/en/ruleGraphs.json";
import en_senderLists from "@/messages/en/senderLists.json";
import en_reports from "@/messages/en/reports.json";
import en_destinations from "@/messages/en/destinations.json";
import en_mailboxes from "@/messages/en/mailboxes.json";
import en_organizations from "@/messages/en/organizations.json";
import en_settings from "@/messages/en/settings.json";
import en_security from "@/messages/en/security.json";
import en_system from "@/messages/en/system.json";
import tr_common from "@/messages/tr/common.json";
import tr_nav from "@/messages/tr/nav.json";
import tr_auth from "@/messages/tr/auth.json";
import tr_overview from "@/messages/tr/overview.json";
import tr_emails from "@/messages/tr/emails.json";
import tr_review from "@/messages/tr/review.json";
import tr_audit from "@/messages/tr/audit.json";
import tr_rules from "@/messages/tr/rules.json";
import tr_ruleGraphs from "@/messages/tr/ruleGraphs.json";
import tr_senderLists from "@/messages/tr/senderLists.json";
import tr_reports from "@/messages/tr/reports.json";
import tr_destinations from "@/messages/tr/destinations.json";
import tr_mailboxes from "@/messages/tr/mailboxes.json";
import tr_organizations from "@/messages/tr/organizations.json";
import tr_settings from "@/messages/tr/settings.json";
import tr_security from "@/messages/tr/security.json";
import tr_system from "@/messages/tr/system.json";

export const en = {
  common: en_common,
  nav: en_nav,
  auth: en_auth,
  overview: en_overview,
  emails: en_emails,
  review: en_review,
  audit: en_audit,
  rules: en_rules,
  ruleGraphs: en_ruleGraphs,
  senderLists: en_senderLists,
  reports: en_reports,
  destinations: en_destinations,
  mailboxes: en_mailboxes,
  organizations: en_organizations,
  settings: en_settings,
  security: en_security,
  system: en_system,
};

export const tr: { [N in keyof typeof en]: Record<string, string> } = {
  common: tr_common,
  nav: tr_nav,
  auth: tr_auth,
  overview: tr_overview,
  emails: tr_emails,
  review: tr_review,
  audit: tr_audit,
  rules: tr_rules,
  ruleGraphs: tr_ruleGraphs,
  senderLists: tr_senderLists,
  reports: tr_reports,
  destinations: tr_destinations,
  mailboxes: tr_mailboxes,
  organizations: tr_organizations,
  settings: tr_settings,
  security: tr_security,
  system: tr_system,
};

export type Namespace = keyof typeof en;
export type MessageKey = { [N in Namespace]: `${N}.${Extract<keyof (typeof en)[N], string>}` }[Namespace];
export const MESSAGES = { en: en as { [N in Namespace]: Record<string, string> }, tr };
