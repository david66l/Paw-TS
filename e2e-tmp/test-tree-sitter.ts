import Parser from "web-tree-sitter";

async function main() {
  await Parser.init();
  const Bash = await Parser.Language.load("node_modules/tree-sitter-bash/bash.wasm");
  const parser = new Parser();
  parser.setLanguage(Bash);
  const tree = parser.parse("echo hello");
  console.log("Root type:", tree.rootNode.type);
  console.log("Text:", tree.rootNode.text);
  tree.delete();
  parser.delete();
}

main().catch(console.error);
