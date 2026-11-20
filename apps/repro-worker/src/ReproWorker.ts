import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { SplitDocumentCms } from "@repro/cms-domain/Document/Document.aggregate";
import { MemoryCatalogStore } from "@repro/cms-domain/Workspace/CatalogStore";
import {
  WorkspaceCms,
  WorkspaceCmsApi,
  WorkspaceCmsHandlers,
} from "@repro/cms-domain/Workspace/Workspace.model";
import {
  CampaignQuotaModel,
  EscrowQuotaApi,
  EscrowQuotaHandlers,
  EscrowQuotaModel,
  MarketQuotaApi,
  MarketQuotaHandlers,
  MarketQuotaModel,
} from "@repro/quota-domain/Quota.model";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

const PlatformLive = DomainCloudflare.layerDurableObjects();

const ModelsLive = Layer.mergeAll(
  WorkspaceCms.layer(WorkspaceCmsHandlers.pipe(Layer.provide(MemoryCatalogStore)), {
    legacyData: false,
  }),
  SplitDocumentCms.layer(Layer.empty, { legacyData: false }),
  MarketQuotaModel.layer(MarketQuotaHandlers, { legacyData: false }),
  CampaignQuotaModel.layer(Layer.empty, { legacyData: false }),
  EscrowQuotaModel.layer(EscrowQuotaHandlers, { legacyData: false }),
).pipe(Layer.provide(PlatformLive));

/**
 * Real Cloudflare Worker hosting both abstract reproduction models on
 * `@alchemy.run/domain/Cloudflare` (2.0.0-beta.87).
 *
 * Notice that on 2.0.0-beta.87 the Cloudflare host moved into
 * `@alchemy.run/domain/Cloudflare`, resolving the earlier `beta.84` packaging
 * defect where `@alchemy.run/cloudflare/Domain` imported blocked
 * `@alchemy.run/domain/internal`.
 */
export default class ReproWorker extends Cloudflare.Worker<ReproWorker>()(
  "ReproWorker",
  {
    main: import.meta.url,
    dev: { host: "127.0.0.1", port: 8799, strictPort: true },
  },
  Effect.gen(function* () {
    const cmsApi = yield* WorkspaceCmsApi;
    const marketApi = yield* MarketQuotaApi;
    const escrowApi = yield* EscrowQuotaApi;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://127.0.0.1:8799");
        if (url.pathname === "/healthz") {
          return yield* HttpServerResponse.json({ ok: true, domainVersion: "2.0.0-beta.87" });
        }
        if (url.pathname.startsWith("/cms")) return yield* cmsApi.fetch;
        if (url.pathname.startsWith("/market")) return yield* marketApi.fetch;
        if (url.pathname.startsWith("/escrow")) return yield* escrowApi.fetch;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(ModelsLive)),
) {}
