import { parse } from "unbash";

const cases = [
  "cat file | grep pattern",
  'echo "rm -rf /"',
  "cd .. && rm file",
];

for (const cmd of cases) {
  console.log(`\n=== ${cmd} ===`);
  const ast = parse(cmd);
  console.log(JSON.stringify(ast, null, 2));
}
