import { prisma } from "../../db/client.js";

/**
 * Deletes every EmailSource whose retention window has passed. The Email row
 * itself (subject, bodies, analysis, audit) is untouched — only the raw MIME
 * copy kept for forwarding goes away. Run by the maintenance queue.
 */
export async function purgeExpiredEmailSources(now: Date = new Date()): Promise<number> {
  const result = await prisma.emailSource.deleteMany({ where: { expiresAt: { lt: now } } });
  return result.count;
}
