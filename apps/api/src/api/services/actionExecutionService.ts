import { undoArchiveExecution, UndoRefusedError } from "../../modules/destinations/executors/archiveUndo.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { retryActionExecution as domainRetry } from "../../modules/destinations/retryActionExecution.js";
import { assertEmailExists } from "./emailService.js";
import { InvalidStateError, NotFoundError } from "../errors/ApiError.js";
import { paginateByCursor, type CursorPage, type PaginationQuery } from "../pagination.js";
import { serializeActionExecution, type ActionExecutionResponse } from "../serializers/actionExecutionSerializer.js";

export interface ListActionExecutionsQuery extends PaginationQuery {
  status?: string;
}

export async function listActionExecutions(tenantId: string, query: ListActionExecutionsQuery): Promise<CursorPage<ActionExecutionResponse>> {
  const where: Prisma.ActionExecutionWhereInput = { tenantId };
  if (query.status) where.status = query.status;

  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.actionExecution.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  return { ...page, data: page.data.map(serializeActionExecution) };
}

export async function listActionExecutionsForEmail(
  tenantId: string,
  emailId: string,
  query: PaginationQuery,
): Promise<CursorPage<ActionExecutionResponse>> {
  await assertEmailExists(tenantId, emailId);
  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.actionExecution.findMany({
      where: { tenantId, emailId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  return { ...page, data: page.data.map(serializeActionExecution) };
}

export async function getActionExecutionById(tenantId: string, id: string): Promise<ActionExecutionResponse> {
  const row = await prisma.actionExecution.findFirst({ where: { id, tenantId } });
  if (!row) throw new NotFoundError(`ActionExecution ${id} not found`);
  return serializeActionExecution(row);
}

/** Phase 15: move an archived message back. A refused undo is an API error; an attempted one returns its result (succeeded, failed or ambiguous) with a message for the person. */
export async function undoActionExecution(tenantId: string, id: string, actor: string): Promise<{ status: string; message: string; execution: ActionExecutionResponse }> {
  try {
    const result = await undoArchiveExecution(tenantId, id, actor);
    return { status: result.status, message: result.message, execution: serializeActionExecution(result.execution) };
  } catch (error) {
    if (error instanceof UndoRefusedError) {
      if (error.code === "not_found") throw new NotFoundError(error.message);
      throw new InvalidStateError(error.message);
    }
    throw error;
  }
}

export async function retryActionExecution(tenantId: string, id: string): Promise<ActionExecutionResponse> {
  const outcome = await domainRetry(tenantId, id);
  if (outcome.status === "not_found") throw new NotFoundError(`ActionExecution ${id} not found`);
  if (outcome.status === "invalid_state") throw new InvalidStateError(outcome.reason);
  return serializeActionExecution(outcome.execution);
}
