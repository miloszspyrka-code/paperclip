// Shared guard for heartbeat run event sequence conflicts. The unique index
// (run_id, seq) added in migration 0222 turns a lost race between concurrent
// event writers into a hard 23505 error; callers use this predicate to retry
// with a freshly allocated sequence instead of failing the run lifecycle.
export function isRunEventSeqConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  // The only insert path using this guard targets heartbeat_run_events, whose
  // single unique constraint is (run_id, seq). Any 23505 surfacing there is a
  // sequence collision; a false positive costs one harmless realloc-retry,
  // while a false negative would fail the run lifecycle.
  const code = candidate.code ?? candidate.cause?.code;
  return code === "23505";
}

export async function insertRunEventWithSeqRetry(
  insert: (seq: number) => Promise<unknown>,
  initialSeq: number,
  reallocate: () => Promise<number>,
  maxAttempts = 3,
): Promise<number> {
  let seq = initialSeq;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await insert(seq);
      return seq;
    } catch (error) {
      if (attempt >= maxAttempts || !isRunEventSeqConflict(error)) throw error;
      seq = await reallocate();
    }
  }
}
