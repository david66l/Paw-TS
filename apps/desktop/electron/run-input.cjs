/** Preserve intent across the Electron boundary; omitted budgets use host settings. */
function runInputFields(payload) {
  const history = Array.isArray(payload?.history)
    ? payload.history
        .filter(
          (t) =>
            t &&
            (t.role === "user" || t.role === "assistant") &&
            typeof t.content === "string" &&
            t.content.trim(),
        )
        .map((t) => ({ role: t.role, content: t.content.trim() }))
    : undefined;
  return {
    ...(payload?.visualAudit === true ? { visualAudit: true } : {}),
    ...(payload?.taskMode === "long" ? { taskMode: "long" } : {}),
    intent:
      payload?.intent === "recover"
        ? "recover"
        : payload?.intent === "reset"
          ? "reset"
          : "continue",
    ...(Number.isSafeInteger(payload?.maxSteps) && payload.maxSteps > 0
      ? { maxSteps: payload.maxSteps }
      : {}),
    ...(history ? { history } : {}),
    ...(Array.isArray(payload?.attachments) ? { attachments: payload.attachments } : {}),
  };
}
module.exports = { runInputFields };
