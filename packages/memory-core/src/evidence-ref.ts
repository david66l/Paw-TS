export function evidenceSourceIdV1(evidenceRef: string): string {
  const value = evidenceRef.trim();
  if (!value) throw namedError("MemoryEvidenceRefInvalid");
  const marker = value.indexOf("#");
  return marker > 0 ? value.slice(0, marker) : value;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
