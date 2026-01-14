import { isBindingIdentifier, walk } from "oxc-walker";
import type { VueCompilerOptions } from "@vue/language-core";
import type { BindingIdentifier, Node, Program } from "oxc-parser";
import { getRange, type Range } from "./utils";

export function collectBindingRanges(ast: Program, vueCompilerOptions: VueCompilerOptions) {
    const bindings: Range[] = [];
    const components: Range[] = [];

    for (const node of ast.body) {
        switch (node.type) {
            case "VariableDeclaration": {
                for (const decl of node.declarations) {
                    bindings.push(
                        ...collectBindingIdentifiers(decl.id).map((i) => i.range),
                    );
                }
                break;
            }
            case "ClassDeclaration":
            case "FunctionDeclaration":
            case "TSEnumDeclaration": {
                if (node.id) {
                    bindings.push(getRange(node.id));
                }
                break;
            }
            case "ImportDeclaration": {
                if (node.importKind === "type") {
                    break;
                }
                const isVue = vueCompilerOptions.extensions.some((ext) => node.source.value.endsWith(ext));

                for (const specifier of node.specifiers) {
                    const range = getRange(specifier.local);

                    switch (specifier.type) {
                        case "ImportDefaultSpecifier": {
                            if (isVue) {
                                components.push(range);
                            }
                            else {
                                bindings.push(range);
                            }
                            break;
                        }
                        case "ImportNamespaceSpecifier": {
                            bindings.push(range);
                            break;
                        }
                        case "ImportSpecifier": {
                            if (specifier.importKind === "type") {
                                continue;
                            }
                            if (
                                isVue &&
                                specifier.imported.type === "Identifier" &&
                                specifier.imported.name === "default"
                            ) {
                                components.push(range);
                            }
                            else {
                                bindings.push(range);
                            }
                            break;
                        }
                    }
                }
                break;
            }
        }
    }

    return {
        bindings,
        components,
    };
}

export function collectBindingIdentifiers(node: Node) {
    const result: {
        name: string;
        range: Range;
        isRest: boolean;
    }[] = [];

    walk(node, {
        enter(node, parent) {
            if (isBindingIdentifier(node, parent)) {
                result.push({
                    name: (node as BindingIdentifier).name,
                    range: getRange(node),
                    isRest: parent?.type === "RestElement",
                });
            }
        },
    });

    return result;
}
