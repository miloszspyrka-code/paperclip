import { describe, expect, it } from "vitest";
import { insertRunEventWithSeqRetry, isRunEventSeqConflict } from "../services/run-event-seq-retry.js";

describe("run event seq conflict retry", () => {
  it("treats any 23505 on the heartbeat insert path as a sequence conflict", () => {
    expect(isRunEventSeqConflict({ code: "23505", message: "duplicate key value violates unique constraint \"heartbeat_run_events_run_seq_uniq\"" })).toBe(true);
    expect(isRunEventSeqConflict({ cause: { code: "23505" }, message: "insert failed" })).toBe(true);
    expect(isRunEventSeqConflict({ code: "42P07" })).toBe(false);
    expect(isRunEventSeqConflict(null)).toBe(false);
  });

  it("reallocates the sequence on conflict and returns the persisted seq", async () => {
    const inserted: number[] = [];
    let attempts = 0;
    const seq = await insertRunEventWithSeqRetry(
      async (candidate) => {
        attempts += 1;
        if (attempts === 1) {
          throw { code: "23505", message: "heartbeat_run_events_run_seq_uniq" };
        }
        inserted.push(candidate);
      },
      1,
      async () => 2,
    );
    expect(attempts).toBe(2);
    expect(inserted).toEqual([2]);
    expect(seq).toBe(2);
  });

  it("gives up after maxAttempts instead of looping forever", async () => {
    let attempts = 0;
    await expect(insertRunEventWithSeqRetry(
      async () => {
        attempts += 1;
        throw { code: "23505", message: "heartbeat_run_events_run_seq_uniq" };
      },
      1,
      async () => 99,
    )).rejects.toMatchObject({ code: "23505" });
    expect(attempts).toBe(3);
  });

  it("propagates non-sequence errors immediately", async () => {
    let attempts = 0;
    await expect(insertRunEventWithSeqRetry(
      async () => {
        attempts += 1;
        throw new Error("connection refused");
      },
      1,
      async () => 2,
    )).rejects.toThrow("connection refused");
    expect(attempts).toBe(1);
  });
});
