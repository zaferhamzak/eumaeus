import { prisma } from "../../db/client.js";
import {
  createOrganization as domainCreateOrganization,
  updateOrganization as domainUpdateOrganization,
  deactivateOrganization as domainDeactivateOrganization,
  getOrganizationById,
  OrganizationValidationError,
} from "../../modules/tenancy/organizations.js";
import { NotFoundError, ValidationError } from "../errors/ApiError.js";
import { paginateByCursor, type CursorPage, type PaginationQuery } from "../pagination.js";
import { serializeOrganization, type OrganizationResponse } from "../serializers/organizationSerializer.js";
import type { CreateOrganizationBody, UpdateOrganizationBody } from "../schemas/organizations.js";

export interface OrganizationListCaller {
  userId: string;
  isSuperAdmin: boolean;
}

/**
 * Phase 11: membership-filtered — a superAdmin sees every organization
 * (unchanged prior behavior); anyone else sees only organizations they have
 * an ACTIVE Membership in, via a relation filter through Tenant's own
 * `memberships` back-relation. Direct fix for "herkes kendi içinde bazı
 * organizasyonlara bakabilsin" (this phase's original request).
 */
export async function listOrganizations(caller: OrganizationListCaller, query: PaginationQuery): Promise<CursorPage<OrganizationResponse>> {
  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.tenant.findMany({
      where: caller.isSuperAdmin ? undefined : { memberships: { some: { userId: caller.userId, status: "active" } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  return { ...page, data: page.data.map(serializeOrganization) };
}

export async function getOrganization(id: string): Promise<OrganizationResponse> {
  const org = await getOrganizationById(id);
  if (!org) throw new NotFoundError(`Organization ${id} not found`);
  return serializeOrganization(org);
}

export async function createOrganization(body: CreateOrganizationBody, actor?: string): Promise<OrganizationResponse> {
  try {
    const org = await domainCreateOrganization(body, actor);
    return serializeOrganization(org);
  } catch (error) {
    if (error instanceof OrganizationValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
}

export async function updateOrganization(id: string, body: UpdateOrganizationBody, actor?: string): Promise<OrganizationResponse> {
  try {
    const updated = await domainUpdateOrganization(id, body, actor);
    if (!updated) throw new NotFoundError(`Organization ${id} not found`);
    return serializeOrganization(updated);
  } catch (error) {
    if (error instanceof OrganizationValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
}

/** Soft — see modules/tenancy/organizations.ts's deactivateOrganization(). */
export async function deactivateOrganization(id: string, actor?: string): Promise<OrganizationResponse> {
  const updated = await domainDeactivateOrganization(id, actor);
  if (!updated) throw new NotFoundError(`Organization ${id} not found`);
  return serializeOrganization(updated);
}
