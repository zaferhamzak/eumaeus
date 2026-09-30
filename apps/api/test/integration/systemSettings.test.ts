import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";
import { getSystemSettings, updateSystemSettings, resolveSmtpPassword, clearSystemSettingsCache } from "../../src/modules/settings/systemSettings.js";

describe("systemSettings — the single UI-editable settings row", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("find-or-create: the first read seeds a row from env defaults, a second read returns the SAME row (not a second one)", async () => {
    const first = await getSystemSettings();
    expect(first.smtpFromName).toBe("Eumaeus");
    clearSystemSettingsCache();
    const second = await getSystemSettings();
    expect(second.id).toBe(first.id);
    expect(await prisma.systemSettings.count()).toBe(1);
  });

  it("updateSystemSettings only changes the fields provided, leaving everything else untouched", async () => {
    await getSystemSettings();
    const updated = await updateSystemSettings({ appBaseUrl: "https://app.example.com" }, "admin@example.com");
    expect(updated.appBaseUrl).toBe("https://app.example.com");
    expect(updated.smtpFromName).toBe("Eumaeus"); // untouched default
    expect(updated.updatedBy).toBe("admin@example.com");
  });

  it("a subsequent getSystemSettings() reflects the update immediately (cache is invalidated on write)", async () => {
    await getSystemSettings();
    await updateSystemSettings({ sessionTtlSeconds: 3600 }, "admin@example.com");
    const fresh = await getSystemSettings();
    expect(fresh.sessionTtlSeconds).toBe(3600);
  });

  it("SMTP password: setting it stores it ENCRYPTED (never plaintext in the column), and resolveSmtpPassword() round-trips it", async () => {
    await getSystemSettings();
    const updated = await updateSystemSettings({ smtpHost: "smtp.example.com", smtpPassword: "super-secret-app-password" }, "admin@example.com");
    expect(updated.smtpPasswordEncrypted).not.toBeNull();
    expect(updated.smtpPasswordEncrypted).not.toContain("super-secret-app-password");
    await expect(resolveSmtpPassword()).resolves.toBe("super-secret-app-password");
  });

  it("omitting smtpPassword on a later update leaves the existing password unchanged", async () => {
    await getSystemSettings();
    await updateSystemSettings({ smtpHost: "smtp.example.com", smtpPassword: "original-password" }, "admin@example.com");
    await updateSystemSettings({ smtpFromName: "New Name" }, "admin@example.com"); // no smtpPassword field at all
    await expect(resolveSmtpPassword()).resolves.toBe("original-password");
  });

  it('an explicit empty-string smtpPassword CLEARS the stored password', async () => {
    await getSystemSettings();
    await updateSystemSettings({ smtpHost: "smtp.example.com", smtpPassword: "will-be-cleared" }, "admin@example.com");
    const cleared = await updateSystemSettings({ smtpPassword: "" }, "admin@example.com");
    expect(cleared.smtpPasswordEncrypted).toBeNull();
    await expect(resolveSmtpPassword()).resolves.toBeNull();
  });

  it("resolveSmtpPassword() returns null when no password has ever been set", async () => {
    await getSystemSettings();
    await expect(resolveSmtpPassword()).resolves.toBeNull();
  });
});
