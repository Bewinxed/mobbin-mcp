// Per-user Mobbin sessions and tool state. Each user's session lives encrypted in the Store and is
// refreshed under that user's lock, so concurrent requests never spend the same refresh token.
// When a session dies, the user's tokens are dropped and their live context is flagged, so the
// request that found out answers 401 and the client signs in again.
import { AuthError, type Config, MobbinClient, refreshSupabaseSession, type Session, type SessionHandle } from "./api.js";
import type { Store } from "./store.js";
import { createToolContext, type ToolContext } from "./tools.js";

export interface UserContext {
  userId: string;
  tools: ToolContext;
  dead: string | null; // why the Mobbin session died, once it has
}

const MAX_LIVE_CONTEXTS = 1000;

export class Users {
  private locks = new Map<string, Promise<unknown>>();
  private contexts = new Map<string, UserContext>();

  constructor(
    private store: Store,
    private cfg: Config,
  ) {}

  // A fresh sign-in replaces whatever session the user had.
  signIn(session: Session): Promise<void> {
    return this.locked(session.user.id, async () => this.store.saveSession(session.user.id, session));
  }

  context(userId: string): UserContext {
    let ctx = this.contexts.get(userId);
    if (ctx) {
      this.contexts.delete(userId); // re-insert: the map's order is least recently used first
    } else {
      ctx = { userId, dead: null } as UserContext;
      ctx.tools = createToolContext(new MobbinClient(this.cfg, this.handle(ctx)));
      if (this.contexts.size >= MAX_LIVE_CONTEXTS) this.contexts.delete(this.contexts.keys().next().value!);
    }
    this.contexts.set(userId, ctx);
    return ctx;
  }

  private handle(ctx: UserContext): SessionHandle {
    const { userId } = ctx;
    const kill = async (reason: string): Promise<never> => {
      this.store.dropUser(userId);
      ctx.dead = reason;
      if (this.contexts.get(userId) === ctx) this.contexts.delete(userId);
      throw new AuthError(`${reason} Sign in to Mobbin again.`);
    };
    return {
      current: async () => this.store.loadSession(userId) ?? kill("No Mobbin session is stored for this account."),
      refresh: (stale) =>
        this.locked(userId, async () => {
          const stored = this.store.loadSession(userId);
          if (!stored) return kill("No Mobbin session is stored for this account.");
          // Another request already refreshed it, or the user signed in again: use that session.
          if (stored.refresh_token !== stale.refresh_token) return stored;
          let next: Session;
          try {
            next = await refreshSupabaseSession(this.cfg, stale.refresh_token);
          } catch (e) {
            if (e instanceof AuthError) return kill(e.message + ".");
            throw e;
          }
          this.store.saveSession(userId, next);
          return next;
        }),
      adopt: (rotated) => this.locked(userId, async () => this.store.saveSession(userId, rotated)),
      kill,
    };
  }

  private async locked<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(userId) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(userId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(userId) === tail) this.locks.delete(userId);
    }
  }
}
