import { parse } from "unbash";

const ast = parse("rm -rf /");
console.log(JSON.stringify(ast, null, 2));
