export function getVerificationSection(): string {
  return `# Verification

Before final_answer, verify it works: run the tests, execute the script, check the output. Report truthfully — never say "all tests pass" when you did not run them. If verification fails, fix it before submitting.`;
}
