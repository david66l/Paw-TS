import {
  createEvidenceIndex,
  createEvidenceResolver,
  createInMemoryStore,
} from "../src/index.js";

const scope = {
  tenantId: "example",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repository-1",
};
const store = createInMemoryStore({ scope });

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

const index = createEvidenceIndex({
  profile: { scope, maxCards: 8, maxInjectedTokens: 2_048 },
  provider: store,
  archive: store,
});
const memory = createEvidenceResolver({ index });
const result = await memory.resolve(
  "How long was my Kyoto trip?",
  new AbortController().signal,
);

console.log(result.packetSources.map((source) => source.text));
