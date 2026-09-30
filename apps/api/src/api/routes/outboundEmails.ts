import type { FastifyInstance } from "fastify";
import type { OutboundEmail, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { paginateByCursor, paginationQuerySchema } from "../pagination.js";
import { requirePermission } from "../plugins/requirePermission.js";
import { ForbiddenError } from "../errors/ApiError.js";
import { OUTBOUND_KINDS } from "../../modules/email/outboundLog.js";

/**
 * 1.2 (F): the delivery log. An organization sees what was sent on its
 * behalf (audit:read, like the audit log); the system administrator sees
 * everything, including system emails that belong to no organization.
 */
const listQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(["sent", "failed"]).optional(),
    kind: z.enum(OUTBOUND_KINDS).optional(),
  })
  .strict();

const adminQuerySchema = listQuerySchema.extend({ organizationId: z.string().min(1).optional() }).strict();

export interface OutboundEmailResponse {
  id: string;
  kind: string;
  toAddress: string;
  subject: string;
  status: string;
  error: string | null;
  messageId: string | null;
  relatedId: string | null;
  createdAt: string;
  organization?: { id: string; name: string } | null;
}

function serialize(row: OutboundEmail & { tenant?: { id: string; name: string } | null }): OutboundEmailResponse {
  return {
    id: row.id,
    kind: row.kind,
    toAddress: row.toAddress,
    subject: row.subject,
    status: row.status,
    error: row.error,
    messageId: row.messageId,
    relatedId: row.relatedId,
    createdAt: row.createdAt.toISOString(),
    ...(row.tenant !== undefined ? { organization: row.tenant ? { id: row.tenant.id, name: row.tenant.name } : null } : {}),
  };
}

async function list(where: Prisma.OutboundEmailWhereInput, query: z.infer<typeof listQuerySchema>, withOrganization: boolean) {
  if (query.status) where.status = query.status;
  if (query.kind) where.kind = query.kind;
  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.outboundEmail.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
      ...(withOrganization ? { include: { tenant: { select: { id: true, name: true } } } } : {}),
    }),
  );
  return { ...page, data: page.data.map(serialize) };
}

export function registerOutboundEmailRoutes(app: FastifyInstance): void {
  app.get("/api/v1/outbound-emails", { preHandler: requirePermission("audit:read") }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    return list({ tenantId: request.tenantId }, query, false);
  });

  app.get("/api/v1/admin/outbound-emails", async (request) => {
    if (!request.user?.isSuperAdmin) throw new ForbiddenError("Only the system administrator can see every outgoing email");
    const query = adminQuerySchema.parse(request.query);
    const { organizationId, ...rest } = query;
    return list(organizationId ? { tenantId: organizationId } : {}, rest, true);
  });
}
