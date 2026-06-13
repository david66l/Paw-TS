import { parse } from "unbash";

const cases = [
  "echo hello",
  "rm -rf /",
  "cat file | grep pattern",
  'echo "rm -rf /"',
  "cd .. && rm file",
  "find . -delete",
  "FOO=bar echo ok",
];

for (const cmd of cases) {
  try {
    const ast = parse(cmd);
    console.log(`✅ ${cmd}`);
    console.log("  type:", ast.type);
    if (ast.commands) {
      for (const c of ast.commands) {
        console.log("  command:", c.type, c.name?.text || "(no name)");
      }
    }
  } catch (e) {
    console.log(`❌ ${cmd}: ${e}`);
  }
}
