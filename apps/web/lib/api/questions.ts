import { apiRequest } from "./client";

/** Phase 22: an organization's own questions for Jev, read by rules as answers.<key>. */
export type QuestionType = "noul" | "choice" | "score";

export type NoulCriteria = { true?: string; false?: string };
export type ChoiceCriteria = Record<string, string>;
export type ScoreCriteria = string[];
export type QuestionCriteria = NoulCriteria | ChoiceCriteria | ScoreCriteria;

export interface Question {
  id: string;
  key: string;
  /** "answers.<key>" */
  field: string;
  type: QuestionType;
  instructions: string;
  criteria: QuestionCriteria | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Names of the rules and rule graphs that read this answer (list response only). */
  usedBy?: string[];
}

export interface CreateQuestionInput {
  key: string;
  type: QuestionType;
  instructions: string;
  criteria?: QuestionCriteria | null;
}

export interface UpdateQuestionInput {
  instructions?: string;
  criteria?: QuestionCriteria | null;
}

export function listQuestions(organizationId: string, signal?: AbortSignal) {
  return apiRequest<{ data: Question[]; limit: number }>("/api/v1/questions", {
    organizationId,
    signal,
  });
}

export function createQuestion(
  organizationId: string,
  input: CreateQuestionInput,
) {
  return apiRequest<Question>("/api/v1/questions", {
    method: "POST",
    body: input,
    organizationId,
  });
}

export function updateQuestion(
  organizationId: string,
  id: string,
  input: UpdateQuestionInput,
) {
  return apiRequest<Question>(`/api/v1/questions/${id}`, {
    method: "PATCH",
    body: input,
    organizationId,
  });
}

/** 409 with error.details = { usedBy } while rules read the answer; force deletes anyway. */
export function deleteQuestion(
  organizationId: string,
  id: string,
  force = false,
) {
  return apiRequest<void>(`/api/v1/questions/${id}`, {
    method: "DELETE",
    query: force ? { force: "true" } : undefined,
    organizationId,
  });
}
