import { hyphenate } from "@vue/shared";
import type CompilerDOM from "@vue/compiler-dom";
import type { IRTemplate } from "./parse/ir";

export { hyphenate as hyphenateTag };

export function hyphenateAttr(str: string) {
    let hyphenated = hyphenate(str);
    if (str && str[0] !== str[0].toLowerCase()) {
        hyphenated = "-" + hyphenated;
    }
    return hyphenated;
}

export function getAttributeValueOffset(node: CompilerDOM.TextNode) {
    let offset = node.loc.start.offset;
    if (node.loc.source.startsWith("\"") || node.loc.source.startsWith("'")) {
        offset++;
    }
    return offset;
}

export function getElementTagOffsets(node: CompilerDOM.ElementNode, template: IRTemplate) {
    const offsets = [
        template.content.indexOf(node.tag, node.loc.start.offset),
    ];
    if (!node.isSelfClosing && template.lang === "html") {
        const endTagOffset = node.loc.start.offset + node.loc.source.lastIndexOf(node.tag);
        if (endTagOffset > offsets[0]) {
            offsets.push(endTagOffset);
        }
    }
    return offsets as [number] | [number, number];
}
