import { walk } from "oxc-walker";
import type { Program } from "oxc-parser";
import { getRange, type Range } from "./utils";

export function collectImportRanges(ast: Program) {
    const imports: Range[] = [];

    walk(ast, {
        enter(node) {
            if (
                node.type === "ImportDeclaration" ||
                node.type === "ImportExpression" ||
                node.type === "TSImportType"
            ) {
                const { source } = node;
                if (source.type === "Literal" && typeof source.value === "string") {
                    imports.push(getRange(source));
                }
            }
        },
    });

    return imports;
}
