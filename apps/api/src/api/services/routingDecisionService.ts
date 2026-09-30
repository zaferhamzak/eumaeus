import { prisma } from "../../db/client.js";
import { assertEmailExists } from "./emailService.js";
import { NotFoundError } from "../errors/ApiError.js";
import { paginateByCursor, type CursorPage, type PaginationQuery } from "../pagination.js";
import { serializeRoutingDecision, type RoutingDecisionResponse } from "../serializers/routingDecisionSerializer.js";

export async function listRoutingDecisions(tenantId: string, query: PaginationQuery): Promise<CursorPage<RoutingDecisionResponse>> {
  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.routingDecision.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  return { ...page, data: page.data.map(serializeRoutingDecision) };
}

export async function getRoutingDecisionById(tenantId: string, id: string): Promise<RoutingDecisionResponse> {
  const row = await prisma.routingDecision.findFirst({ where: { id, tenantId } });
  if (!row) throw new NotFoundError(`Routing decision ${id} not found`);
  return serializeRoutingDecision(row);
}

export async function getRoutingDecisionForEmail(tenantId: string, emailId: string): Promise<RoutingDecisionResponse> {
  await assertEmailExists(tenantId, emailId);
  const row = await prisma.routingDecision.findFirst({ where: { emailId, supersededAt: null } });
  if (!row || row.tenantId !== tenantId) throw new NotFoundError(`No routing decision exists yet for email ${emailId}`);
  return serializeRoutingDecision(row);
}
