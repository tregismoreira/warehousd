import { describe, it, expectTypeOf } from "vitest";
import type { z } from "zod";
import type {
  BrokerResult,
  GetDocumentResult,
  MutationResult,
  VisibleSchema,
  CollectionListing,
  SearchedCollection,
  Refusal,
  MutationRefusal,
} from "@warehousd/broker";
import * as S from "../lib/api-schema/responses";

// These assertions do nothing at runtime. `pnpm typecheck` is what runs them — a broker response
// type that gains, loses or renames a field fails there, which is the only thing keeping the
// mirror honest. `pnpm test` transpiles without checking and would pass regardless.
describe("api-schema parity", () => {
  it("mirrors the broker response types", () => {
    expectTypeOf<z.infer<typeof S.BrokerResultSchema>>().toEqualTypeOf<BrokerResult>();
    expectTypeOf<z.infer<typeof S.GetDocumentResultSchema>>().toEqualTypeOf<GetDocumentResult>();
    expectTypeOf<z.infer<typeof S.MutationResultSchema>>().toEqualTypeOf<MutationResult>();
    expectTypeOf<z.infer<typeof S.VisibleSchemaSchema>>().toEqualTypeOf<VisibleSchema>();
    expectTypeOf<z.infer<typeof S.CollectionListingSchema>>().toEqualTypeOf<CollectionListing>();
    expectTypeOf<z.infer<typeof S.SearchedCollectionSchema>>().toEqualTypeOf<SearchedCollection>();
    expectTypeOf<z.infer<typeof S.RefusalSchema>>().toEqualTypeOf<Refusal>();
    expectTypeOf<z.infer<typeof S.MutationRefusalSchema>>().toEqualTypeOf<MutationRefusal>();
  });
});
