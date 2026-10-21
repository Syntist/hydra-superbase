/** Serializes SDK session changes and discards work from previous accounts. */
export class SupabaseSession {
  private generation = 0;
  private mutations: Promise<unknown> = Promise.resolve();
  private pending: { token: string; promise: Promise<boolean> } | null = null;
  userId: string | null = null;

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => undefined);
    return result;
  }

  authenticate(
    token: string,
    exchange: () => Promise<{ userId: string; apply: () => Promise<void> }>
  ): Promise<boolean> {
    if (this.pending?.token === token) return this.pending.promise;
    const generation = ++this.generation;
    this.userId = null;
    const promise = (async () => {
      const session = await exchange();
      return this.mutate(async () => {
        if (generation !== this.generation) return false;
        await session.apply();
        if (generation !== this.generation) return false;
        this.userId = session.userId;
        return true;
      });
    })();
    this.pending = { token, promise };
    void promise
      .finally(() => {
        if (this.pending?.promise === promise) this.pending = null;
      })
      .catch(() => undefined);
    return promise;
  }

  signOut(clear: () => Promise<void>) {
    ++this.generation;
    this.userId = null;
    this.pending = null;
    return this.mutate(clear);
  }
}
