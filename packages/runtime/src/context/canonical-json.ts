/**
 * Runtime Context hash/render boundary.
 *
 * The encoder itself lives in `@paw/core` — this module only pins the name the
 * context layer imports it by, so every runtime hash, render and payload-binding
 * key provably goes through one encoder.
 */
export {
  canonicalJsonStringifyV1,
  hashCanonicalJsonV1,
  hashTextV1,
  immutableCanonicalJsonCloneV1,
} from "@paw/core";
