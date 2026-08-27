import type { JsonValue } from "@paw/protocol";

import {
  type MemoryAspectEdgeLinkingInputV1,
  type MemoryAspectEdgeLinkingV1,
  deriveMemoryAspectEdgeInputRevisionV1,
} from "./aspect-edge-linker.js";
import { hashCanonicalJsonV1 } from "./canonical.js";

export const PAW_MEMORY_ASPECT_EDGE_RECOVERY_VERSION_V1 =
  "paw.memory-aspect-edge-recovery.v1:high-signal-singleton" as const;

export interface MemoryAspectEdgeRecoveryBuildV1 {
  readonly builderVersion: typeof PAW_MEMORY_ASPECT_EDGE_RECOVERY_VERSION_V1;
  readonly sourceGraphRevision: string;
  readonly recoveryRevision: string;
  readonly packets: readonly MemoryAspectEdgeLinkingInputV1[];
  readonly metrics: Readonly<{
    sourcePacketCount: number;
    unresolvedPairCount: number;
    highSignalPairCount: number;
    selectedPairCount: number;
    truncatedPairCount: number;
  }>;
}

/** Converts only high-signal unresolved pairs into isolated second-look calls. */
export function buildMemoryAspectEdgeRecoveryCandidatesV1(
  input: Readonly<{
    packets: readonly MemoryAspectEdgeLinkingInputV1[];
    linkings: readonly MemoryAspectEdgeLinkingV1[];
    maxPackets?: number;
  }>,
): MemoryAspectEdgeRecoveryBuildV1 {
  if (input.packets.length === 0) {
    throw namedError("MemoryAspectEdgeRecoveryPacketsInvalid");
  }
  const maxPackets = input.maxPackets ?? 32;
  if (!Number.isSafeInteger(maxPackets) || maxPackets < 1 || maxPackets > 128) {
    throw namedError("MemoryAspectEdgeRecoveryLimitInvalid");
  }
  const graphRevision = input.packets[0]?.snapshot.revision as string;
  if (
    input.packets.some((packet) => packet.snapshot.revision !== graphRevision)
  ) {
    throw namedError("MemoryAspectEdgeRecoveryRevisionConflict");
  }
  const linkingByInputRevision = new Map(
    input.linkings.map((linking) => [linking.edgeInputRevision, linking]),
  );
  if (linkingByInputRevision.size !== input.linkings.length) {
    throw namedError("MemoryAspectEdgeRecoveryLinkingDuplicate");
  }
  const allStatements = input.packets.flatMap((packet) => [
    packet.source.statement,
    ...packet.targets.map((target) => target.statement),
  ]);
  const weights = inverseDocumentWeights(allStatements.map(terms));
  const unresolved: Array<{
    packet: MemoryAspectEdgeLinkingInputV1;
    targetIndex: number;
    score: number;
    needsTypeAdjudication: boolean;
  }> = [];
  for (const packet of input.packets) {
    const linking = linkingByInputRevision.get(
      deriveMemoryAspectEdgeInputRevisionV1(packet),
    );
    const decisions = new Map(
      (linking?.decisions ?? []).map((decision) => [
        decision.targetClaimId,
        decision,
      ]),
    );
    for (const [targetIndex, target] of packet.targets.entries()) {
      const decision = decisions.get(target.claimId);
      const decidedEdge =
        decision?.disposition === "edge"
          ? linking?.edges.find(
              (edge) =>
                unorderedPairKey(edge.fromClaimId, edge.toClaimId) ===
                unorderedPairKey(packet.source.claimId, target.claimId),
            )
          : undefined;
      const needsTypeAdjudication =
        decidedEdge?.edgeType === "supports" &&
        target.allowedProposals.some(
          (proposal) => proposal.edgeType !== "supports",
        );
      if (decision?.disposition === "edge" && !needsTypeAdjudication) continue;
      const score =
        recoveryScore(
          packet.source.statement,
          target.statement,
          target.allowedProposals.length,
          linking?.settlement !== "settled",
          weights,
        ) + (needsTypeAdjudication ? 20 : 0);
      unresolved.push({ packet, targetIndex, score, needsTypeAdjudication });
    }
  }
  const highSignal = unresolved
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.packet.aspectId.localeCompare(right.packet.aspectId) ||
        left.packet.source.claimId.localeCompare(right.packet.source.claimId) ||
        (left.packet.targets[left.targetIndex]?.claimId ?? "").localeCompare(
          right.packet.targets[right.targetIndex]?.claimId ?? "",
        ),
    );
  const selected = highSignal
    .slice(0, maxPackets)
    .map(({ packet, targetIndex }) => {
      const target = packet.targets[targetIndex];
      if (target === undefined) {
        throw namedError("MemoryAspectEdgeRecoveryTargetMissing");
      }
      return Object.freeze({
        ...packet,
        targets: Object.freeze([target]),
      });
    });
  const metrics = Object.freeze({
    sourcePacketCount: input.packets.length,
    unresolvedPairCount: unresolved.length,
    highSignalPairCount: highSignal.length,
    selectedPairCount: selected.length,
    truncatedPairCount: Math.max(0, highSignal.length - selected.length),
  });
  const body = {
    builderVersion: PAW_MEMORY_ASPECT_EDGE_RECOVERY_VERSION_V1,
    sourceGraphRevision: graphRevision,
    maxPackets,
    packets: selected.map((packet) => ({
      edgeInputRevision: deriveMemoryAspectEdgeInputRevisionV1(packet),
    })),
    metrics,
  };
  return Object.freeze({
    ...body,
    recoveryRevision: hashCanonicalJsonV1(body as unknown as JsonValue),
    packets: Object.freeze(selected),
  });
}

function recoveryScore(
  left: string,
  right: string,
  proposalCount: number,
  failedPacket: boolean,
  weights: ReadonlyMap<string, number>,
): number {
  const overlap = discriminantOverlap(left, right, weights);
  const normalized = `${left}\n${right}`.normalize("NFKC").toLocaleLowerCase();
  const cueScore =
    (CHANGE_CUE.test(normalized) ? 4 : 0) +
    (CAUSAL_CUE.test(normalized) ? 4 : 0) +
    (CONDITION_CUE.test(normalized) ? 2 : 0);
  if (overlap <= 0 && cueScore === 0 && !failedPacket) return 0;
  return overlap * 10 + cueScore + (failedPacket ? 3 : 0) + proposalCount / 10;
}

function discriminantOverlap(
  left: string,
  right: string,
  weights: ReadonlyMap<string, number>,
): number {
  const rightTerms = terms(right);
  let score = 0;
  for (const term of terms(left)) {
    if (rightTerms.has(term)) score += weights.get(term) ?? 0;
  }
  return score;
}

function terms(value: string): ReadonlySet<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const result = new Set(normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? []);
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...match[0]];
    for (let index = 0; index + 1 < chars.length; index += 1) {
      result.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return result;
}

function inverseDocumentWeights(
  documents: readonly ReadonlySet<string>[],
): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>();
  for (const document of documents) {
    for (const term of document) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  return new Map(
    [...frequencies].map(([term, frequency]) => [
      term,
      Math.log((documents.length + 1) / (frequency + 1)),
    ]),
  );
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function unorderedPairKey(left: string, right: string): string {
  return left.localeCompare(right) <= 0
    ? `${left}\u0000${right}`
    : `${right}\u0000${left}`;
}

const CHANGE_CUE =
  /\b(?:now|no longer|instead|changed|shifted|switched|stopped|started|began|became|returned to|gave up|reconsidered|decided to|replaced)\b|现在|不再|改为|转而|停止|开始|变得|重新|放弃|决定|取代/u;
const CAUSAL_CUE =
  /\b(?:because|due to|therefore|led to|resulted in|reinforc(?:e|ed|es|ing)|inspir(?:e|ed|es|ing)|prompt(?:ed|s|ing)|as a result)\b|因为|由于|因此|导致|促使|强化|启发/u;
const CONDITION_CUE =
  /\b(?:when|whenever|if|unless|during|while|depending on|under .+ conditions?)\b|当|如果|除非|期间|取决于|在.+情况下/u;
