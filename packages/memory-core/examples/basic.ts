import {
  createInMemoryEvidenceStoreV1,
  createProductMemoryEvidenceIndexV1,
} from "../src/index.js";

const scope = {
  tenantId: "example",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repository-1",
};
const store = createInMemoryEvidenceStoreV1({ scope });

store.putEvidence([
  {
    evidenceRef: "conversation-1#turn-2",
    sourceKind: "user_input",
    sourceSeq: 2,
    authority: "user_asserted",
    hitContent: "I stayed in Kyoto for seven days.",
    createdAt: "2026-08-01T00:00:00.000Z",
  },
]);
store.putCards([
  {
    id: "trip-duration",
    statement: "Kyoto trip lasted seven days",
    sources: [{ ref: "conversation-1#turn-2" }],
  },
]);

const index = createProductMemoryEvidenceIndexV1({
  profile: { scope, maxCards: 8, maxInjectedTokens: 2_048 },
  provider: store,
  archive: store,
});
const result = await index.search(
  "How long was my Kyoto trip?",
  new AbortController().signal,
);

console.log(result.hits.map((hit) => hit.content));
