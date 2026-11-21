import { DatabaseSync } from "node:sqlite";
import {
  alarmCallbacks,
  className,
  type Host,
  type ListOptions,
  makePlatform,
  type Namespace,
  type ObjectImpl,
  ObjectState,
  type ObjectStateShape,
  type ObjectStorage,
  type Stub,
} from "@alchemy.run/domain/DurableObjects";
import type { Platform } from "@alchemy.run/domain/Platform";
import { type BaseRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export interface InstanceMetrics {
  readonly className: string;
  readonly instanceName: string;
  readonly gets: number;
  readonly puts: number;
  readonly putKeys: number;
  readonly deletes: number;
  readonly lists: number;
  readonly transactions: number;
  readonly totalPutBytes: number;
  readonly metaBytes: number;
  readonly totalStoredKeys: number;
  readonly totalStoredBytes: number;
  readonly keysByPrefix: Record<string, { count: number; bytes: number }>;
  readonly alarmsScheduled: number;
}

export interface InstrumentedHostOptions {
  /** Optional artificial persistence latency per storage transaction (ms). */
  readonly commitDelayMs?: number;
  /** Optional artificial RPC hop latency per DO method call (ms). */
  readonly rpcDelayMs?: number;
}

interface InternalInstance {
  readonly fullClassName: string;
  readonly instanceName: string;
  readonly db: DatabaseSync;
  readonly methods: Record<string, unknown>;
  readonly counters: {
    gets: number;
    puts: number;
    putKeys: number;
    deletes: number;
    lists: number;
    transactions: number;
    totalPutBytes: number;
    alarmsScheduled: number;
  };
  readonly backgroundFibers: Set<Fiber.Fiber<void, never>>;
  readonly fireAlarms: Effect.Effect<void>;
  readonly stopTimers: () => void;
  getAlarm: () => number | null;
}

const prefixOf = (key: string): string => {
  const idx = key.indexOf(":");
  return idx === -1 ? key : `${key.slice(0, idx + 1)}*`;
};

const createSqliteStorage = (
  db: DatabaseSync,
  counters: InternalInstance["counters"],
  commitDelayMs: number,
): ObjectStorage => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  const stmtGet = db.prepare("SELECT v FROM kv WHERE k = ?");
  const stmtPut = db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)");
  const stmtDel = db.prepare("DELETE FROM kv WHERE k = ?");
  const stmtAll = db.prepare("SELECT k, v FROM kv ORDER BY k ASC");
  const stmtAllDesc = db.prepare("SELECT k, v FROM kv ORDER BY k DESC");

  let inTx = false;

  const writeOne = (key: string, value: unknown) => {
    const serialized = JSON.stringify(value);
    stmtPut.run(key, serialized);
    counters.putKeys += 1;
    counters.totalPutBytes += Buffer.byteLength(serialized, "utf8");
  };

  return {
    get: <T>(key: string) =>
      Effect.sync(() => {
        counters.gets += 1;
        const row = stmtGet.get(key) as { v: string } | undefined;
        return row === undefined ? undefined : (JSON.parse(row.v) as T);
      }),
    put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
      Effect.sync(() => {
        counters.puts += 1;
        if (typeof keyOrEntries === "string") {
          writeOne(keyOrEntries, value);
        } else {
          for (const [k, v] of Object.entries(keyOrEntries)) {
            writeOne(k, v);
          }
        }
      })) as ObjectStorage["put"],
    delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
      Effect.sync(() => {
        counters.deletes += 1;
        if (typeof keyOrKeys === "string") {
          const info = stmtDel.run(keyOrKeys);
          return Number(info.changes) > 0;
        }
        let deleted = 0;
        for (const k of keyOrKeys) {
          deleted += Number(stmtDel.run(k).changes);
        }
        return deleted;
      })) as ObjectStorage["delete"],
    list: <T>(options?: ListOptions) =>
      Effect.sync(() => {
        counters.lists += 1;
        const rows = (options?.reverse ? stmtAllDesc.all() : stmtAll.all()) as Array<{
          k: string;
          v: string;
        }>;
        const out = new Map<string, T>();
        for (const row of rows) {
          if (options?.prefix !== undefined && !row.k.startsWith(options.prefix)) continue;
          if (options?.start !== undefined && row.k < options.start) continue;
          if (options?.startAfter !== undefined && row.k <= options.startAfter) continue;
          if (options?.end !== undefined && row.k >= options.end) continue;
          out.set(row.k, JSON.parse(row.v) as T);
          if (options?.limit !== undefined && out.size >= options.limit) break;
        }
        return out;
      }),
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        counters.transactions += 1;
        if (inTx) return yield* effect;
        inTx = true;
        db.exec("BEGIN IMMEDIATE");
        const exit = yield* Effect.exit(effect);
        if (exit._tag === "Success") {
          db.exec("COMMIT");
          inTx = false;
          if (commitDelayMs > 0) {
            yield* Effect.sleep(`${commitDelayMs} millis`);
          }
          return exit.value;
        }
        db.exec("ROLLBACK");
        inTx = false;
        return yield* exit;
      }),
  };
};

/**
 * Runs `@alchemy.run/domain`'s REAL `DurableObjects.makePlatform` over
 * per-instance SQLite KV databases (`node:sqlite`), measuring every storage
 * read, write, byte, key prefix, and lock serialization without mocking any
 * Domain internals.
 */
export const createInstrumentedDoPlatform = (options: InstrumentedHostOptions = {}) => {
  const commitDelayMs = options.commitDelayMs ?? 0;
  const rpcDelayMs = options.rpcDelayMs ?? 0;
  const instances = new Map<string, InternalInstance>();
  const pendingCreation = new Map<string, Promise<InternalInstance>>();
  const scopes: Array<Scope.Closeable> = [];

  const getOrCreate = (
    fullClassName: string,
    instanceName: string,
    impl: ObjectImpl,
  ): Effect.Effect<InternalInstance> =>
    Effect.gen(function* () {
      const mapKey = `${fullClassName}/${instanceName}`;
      const existing = instances.get(mapKey);
      if (existing) return existing;

      const inflight = pendingCreation.get(mapKey);
      if (inflight) {
        return yield* Effect.promise(() => inflight);
      }

      const promise = Effect.runPromise(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          scopes.push(scope);
          const db = new DatabaseSync(":memory:");
          const counters: InternalInstance["counters"] = {
            gets: 0,
            puts: 0,
            putKeys: 0,
            deletes: 0,
            lists: 0,
            transactions: 0,
            totalPutBytes: 0,
            alarmsScheduled: 0,
          };
          const storage = createSqliteStorage(db, counters, commitDelayMs);
          const sem = Semaphore.makeUnsafe(1);
          const backgroundFibers = new Set<Fiber.Fiber<void, never>>();

          let currentAlarm: number | null = null;
          let alarmTimer: ReturnType<typeof setTimeout> | null = null;
          let fireRef: Effect.Effect<void> = Effect.void;
          let closed = false;

          const clearTimer = () => {
            if (alarmTimer !== null) {
              clearTimeout(alarmTimer);
              alarmTimer = null;
            }
          };

          const alarm = {
            get: Effect.sync(() => currentAlarm),
            set: (at: number) =>
              Effect.sync(() => {
                currentAlarm = at;
                counters.alarmsScheduled += 1;
                if (closed) return;
                clearTimer();
                const delay = Math.max(0, at - Date.now());
                // Only auto-fire near-term alarms (< 5s) so long-horizon lease timers
                // don't keep short benchmark processes alive.
                if (delay <= 5_000) {
                  alarmTimer = setTimeout(() => {
                    alarmTimer = null;
                    currentAlarm = null;
                    if (!closed) {
                      void Effect.runPromise(fireRef.pipe(Effect.catchCause(() => Effect.void)));
                    }
                  }, delay);
                  alarmTimer.unref();
                }
              }),
            delete: Effect.sync(() => {
              currentAlarm = null;
              clearTimer();
            }),
          };

          const callbacks = alarmCallbacks(storage, alarm);
          fireRef = callbacks.fire;

          const runtimeCtx: BaseRuntimeContext = {
            Type: "InstrumentedDO",
            id: mapKey,
            env: {},
            get: () => Effect.succeed(undefined),
            set: (id) => Effect.succeed(id),
          } as BaseRuntimeContext;

          const objectState: ObjectStateShape = {
            storage,
            exclusive: (effect) => sem.withPermit(effect),
            waitUntil: (effect) =>
              Effect.gen(function* () {
                const fiber = yield* Effect.forkDetach(
                  effect.pipe(
                    Effect.catchCause(() => Effect.void),
                    Effect.ensuring(
                      Effect.sync(() => {
                        backgroundFibers.delete(fiber);
                      }),
                    ),
                  ),
                );
                backgroundFibers.add(fiber);
              }),
          };

          const methods = yield* impl.pipe(
            Effect.provideService(ObjectState, objectState),
            Effect.provideService(RuntimeContext, runtimeCtx),
            Effect.provideService(Scope.Scope, scope),
            Effect.provide(callbacks.callbacks),
          );

          const instance: InternalInstance = {
            fullClassName,
            instanceName,
            db,
            methods,
            counters,
            backgroundFibers,
            fireAlarms: callbacks.fire,
            stopTimers: () => {
              closed = true;
              clearTimer();
            },
            getAlarm: () => currentAlarm,
          };
          instances.set(mapKey, instance);
          return instance;
        }) as Effect.Effect<InternalInstance>,
      );

      pendingCreation.set(mapKey, promise);
      try {
        return yield* Effect.promise(() => promise);
      } finally {
        pendingCreation.delete(mapKey);
      }
    });

  const hostKey = {};
  const host: Host<never> = {
    claimKey: Effect.succeed(hostKey),
    declare: ({ modelName }, name, impl) =>
      Effect.sync((): Namespace => {
        const full = className(modelName, name);
        return {
          getByName: (instanceName: string): Stub =>
            new Proxy({} as Stub, {
              get:
                (_target, prop: string) =>
                (...args: ReadonlyArray<unknown>) =>
                  Effect.gen(function* () {
                    if (rpcDelayMs > 0) {
                      yield* Effect.sleep(`${rpcDelayMs} millis`);
                    }
                    const inst = yield* getOrCreate(full, instanceName, impl);
                    const fn = inst.methods[prop];
                    if (typeof fn !== "function") {
                      return yield* Effect.die(
                        new Error(`DO ${full}/${instanceName} has no method ${String(prop)}`),
                      );
                    }
                    return yield* (fn as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(
                      ...args,
                    );
                  }),
            }),
        };
      }),
  };

  const layer: Layer.Layer<Platform | SecureRandom.SecureRandom> = Layer.mergeAll(
    makePlatform(host),
    SecureRandom.layerWebCrypto,
  ).pipe(Layer.provide(SecureRandom.layerWebCrypto));

  const drainBackground = Effect.gen(function* () {
    for (let pass = 0; pass < 10; pass++) {
      const fibers: Array<Fiber.Fiber<void, never>> = [];
      for (const inst of instances.values()) {
        for (const f of inst.backgroundFibers) fibers.push(f);
      }
      if (fibers.length === 0) break;
      for (const f of fibers) {
        yield* Fiber.await(f);
      }
    }
  });

  const inspectAll = (): ReadonlyArray<InstanceMetrics> => {
    const results: Array<InstanceMetrics> = [];
    for (const inst of instances.values()) {
      const rows = inst.db.prepare("SELECT k, v FROM kv").all() as Array<{ k: string; v: string }>;
      const keysByPrefix: Record<string, { count: number; bytes: number }> = {};
      let metaBytes = 0;
      let totalStoredBytes = 0;
      for (const row of rows) {
        const bytes = Buffer.byteLength(row.v, "utf8");
        totalStoredBytes += bytes;
        if (row.k === "meta") metaBytes = bytes;
        const p = prefixOf(row.k);
        const bucket = keysByPrefix[p] ?? { count: 0, bytes: 0 };
        bucket.count += 1;
        bucket.bytes += bytes;
        keysByPrefix[p] = bucket;
      }
      results.push({
        className: inst.fullClassName,
        instanceName: inst.instanceName,
        ...inst.counters,
        metaBytes,
        totalStoredKeys: rows.length,
        totalStoredBytes,
        keysByPrefix,
      });
    }
    return results;
  };

  const resetCounters = () => {
    for (const inst of instances.values()) {
      inst.counters.gets = 0;
      inst.counters.puts = 0;
      inst.counters.putKeys = 0;
      inst.counters.deletes = 0;
      inst.counters.lists = 0;
      inst.counters.transactions = 0;
      inst.counters.totalPutBytes = 0;
      inst.counters.alarmsScheduled = 0;
    }
  };

  const close = Effect.gen(function* () {
    yield* drainBackground;
    for (const inst of instances.values()) {
      inst.stopTimers();
      inst.db.close();
    }
    instances.clear();
  });

  return { layer, drainBackground, inspectAll, resetCounters, close };
};
