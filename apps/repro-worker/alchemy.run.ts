import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ReproWorker from "./src/ReproWorker.ts";

export default Alchemy.Stack(
  "AlchemyDomainRepro",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* ReproWorker;
    return { url: worker.url };
  }),
);
