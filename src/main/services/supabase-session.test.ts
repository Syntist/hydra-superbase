import assert from "node:assert/strict";
import { it } from "node:test";
import { SupabaseSession } from "./supabase-session.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it("deduplicates authentication for the same token", async () => {
  const state = new SupabaseSession();
  let exchanges = 0;
  const exchange = async () => {
    exchanges++;
    return { userId: "a", apply: async () => {} };
  };
  const first = state.authenticate("token", exchange);
  assert.equal(state.authenticate("token", exchange), first);
  assert.equal(await first, true);
  assert.equal(state.userId, "a");
  assert.equal(exchanges, 1);
});

it("does not restore an account after sign out while exchanging a token", async () => {
  const state = new SupabaseSession();
  const exchanged = deferred<{ userId: string; apply: () => Promise<void> }>();
  const pending = state.authenticate("old", () => exchanged.promise);
  await state.signOut(async () => {});
  let applied = false;
  exchanged.resolve({
    userId: "old",
    apply: async () => {
      applied = true;
    },
  });
  assert.equal(await pending, false);
  assert.equal(applied, false);
  assert.equal(state.userId, null);
});

it("ignores a slow previous account when a new account signs in", async () => {
  const state = new SupabaseSession();
  const old = deferred<{ userId: string; apply: () => Promise<void> }>();
  const pending = state.authenticate("old", () => old.promise);
  await state.authenticate("new", async () => ({
    userId: "new",
    apply: async () => {},
  }));
  old.resolve({
    userId: "old",
    apply: async () => {
      throw new Error("stale apply");
    },
  });
  assert.equal(await pending, false);
  assert.equal(state.userId, "new");
});

it("serializes sign out after an SDK session update already in progress", async () => {
  const state = new SupabaseSession();
  const started = deferred<void>();
  const finish = deferred<void>();
  const calls: string[] = [];
  const pending = state.authenticate("old", async () => ({
    userId: "old",
    apply: async () => {
      started.resolve();
      await finish.promise;
      calls.push("apply");
    },
  }));
  await started.promise;
  const logout = state.signOut(async () => {
    calls.push("clear");
  });
  finish.resolve();
  assert.equal(await pending, false);
  await logout;
  assert.deepEqual(calls, ["apply", "clear"]);
  assert.equal(state.userId, null);
});

it("can retry authentication after a failed exchange or SDK update", async () => {
  const state = new SupabaseSession();
  for (const applyFailure of [false, true]) {
    await assert.rejects(
      state.authenticate("bad", async () => {
        if (!applyFailure) throw new Error("exchange failed");
        return {
          userId: "bad",
          apply: async () => {
            throw new Error("SDK failed");
          },
        };
      })
    );
    assert.equal(state.userId, null);
  }
  assert.equal(
    await state.authenticate("good", async () => ({
      userId: "good",
      apply: async () => {},
    })),
    true
  );
});
