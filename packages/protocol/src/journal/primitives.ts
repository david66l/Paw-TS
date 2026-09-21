/** JSON primitives shared by every durable payload in the journal. */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A complete JSON payload, stored inline or by a stable content reference. */
export type DurableJsonPayloadV1 =
  | Readonly<{
      kind: "inline";
      value: JsonValue;
      hash: string;
    }>
  | Readonly<{
      kind: "artifact_ref";
      artifactRef: string;
      hash: string;
    }>;
