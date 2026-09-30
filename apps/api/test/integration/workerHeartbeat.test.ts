import { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { getRedisConnection } from "../../src/queue/connection.js";
import { isImapConnectionLeftover, readWorkerStatus, startWorkerHeartbeat, WORKER_HEARTBEAT_KEY } from "../../src/runtime/workerHeartbeat.js";
import { buildTestServer } from "../api/helpers/buildTestServer.js";

describe("worker heartbeat", () => {
  it("is 'down' without a heartbeat, 'ok' while the worker beats, and 'down' again right after a clean stop", async () => {
    const redis = getRedisConnection();
    await redis.del(WORKER_HEARTBEAT_KEY);
    expect(await readWorkerStatus(redis)).toEqual({ status: "down", lastSeenAt: null });

    const stop = startWorkerHeartbeat(redis, () => {});
    await new Promise((r) => setTimeout(r, 50));
    const alive = await readWorkerStatus(redis);
    expect(alive.status).toBe("ok");
    expect(alive.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await redis.ttl(WORKER_HEARTBEAT_KEY)).toBeGreaterThan(0);

    const app = buildTestServer("unused");
    const ready = (await app.inject({ method: "GET", url: "/api/v1/ready" })).json();
    expect(ready.worker.status).toBe("ok");

    await stop();
    expect((await readWorkerStatus(redis)).status).toBe("down");
    const readyAfter = (await app.inject({ method: "GET", url: "/api/v1/ready" })).json();
    // The API itself stays ready; the worker is reported separately.
    expect(readyAfter).toMatchObject({ worker: { status: "down" } });
  });

  it("only imapflow's own connection leftovers are treated as non-fatal", () => {
    expect(isImapConnectionLeftover(Object.assign(new Error("Connection not available"), { code: "NoConnection", _connId: "abc" }))).toBe(true);
    // imapflow 1.7's own connection errors carry the id as `cid`.
    expect(isImapConnectionLeftover(Object.assign(new Error("Connection not available"), { code: "NoConnection", cid: "abc", rejectedFrom: "throttleAbort" }))).toBe(true);
    expect(isImapConnectionLeftover(new Error("something else"))).toBe(false);
    expect(isImapConnectionLeftover(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(false);
    expect(isImapConnectionLeftover(undefined)).toBe(false);
  });

  it("recognises the 'Connection not available' error the installed imapflow actually builds", () => {
    // Guards against imapflow renaming its markers again: this is the error a
    // dropped connection rejects its queued commands with.
    const client = new ImapFlow({ host: "imap.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" }, logger: false });
    const error = (client as unknown as { createNoConnectionError(bye: unknown, meta: object): Error }).createNoConnectionError(false, { rejectedFrom: "throttleAbort" });
    expect(error.message).toBe("Connection not available");
    expect(isImapConnectionLeftover(error)).toBe(true);
  });
});
