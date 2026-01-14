import { SourceMap } from "@vue/language-core";
import { camelize, capitalize } from "@vue/shared";
import { replaceSourceRange, toString } from "muggle-string";
import { parseSync } from "oxc-parser";
import { basename, dirname, extname, join } from "pathe";
import type { Mapping, VueCompilerOptions } from "@vue/language-core";
import { createCompilerOptionsResolver, parseLocalCompilerOptions } from "../compilerOptions";
import { createIR, type IRBlock } from "../parse/ir";
import { collectImportRanges } from "./ranges/import";
import { collectScriptRanges } from "./ranges/script";
import { collectScriptSetupRanges } from "./ranges/scriptSetup";
import { generateScript } from "./script";
import { generateStyle } from "./style";
import { generateTemplate } from "./template";
import type { Code, CodeInformation } from "../types";
import type { Range } from "./ranges/utils";

export interface SourceFile {
    type: "virtual" | "native";
    fileName: string;
    sourceText: string;
    virtualText?: string;
    virtualLang?: string;
    mapper: SourceMap<CodeInformation>;
    imports: Range[];
    references: string[];
}

const referenceRE = /\/\/\/\s*<reference\s+path=["'](.*?)["']\s*\/>/g;

export function createSourceFile(
    fileName: string,
    targetPath: string,
    sourceText: string,
    vueCompilerOptions: VueCompilerOptions,
) {
    const sourceFile = vueCompilerOptions.extensions.some((ext) => fileName.endsWith(ext))
        ? createVirtualFile(targetPath, sourceText, vueCompilerOptions)
        : createNativeFile(targetPath, sourceText, vueCompilerOptions);

    for (const match of sourceText.matchAll(referenceRE)) {
        const path = join(dirname(fileName), match[1]);
        sourceFile.references.push(path);
    }

    return sourceFile;
}

function createVirtualFile(
    fileName: string,
    sourceText: string,
    vueCompilerOptions: VueCompilerOptions,
): SourceFile {
    const ir = createIR(fileName, sourceText);

    // #region vueCompilerOptions
    const options = parseLocalCompilerOptions(ir.comments);
    if (options) {
        const resolver = createCompilerOptionsResolver();
        resolver.add(options, dirname(ir.fileName));
        vueCompilerOptions = resolver.resolve(vueCompilerOptions);
    }
    // #endregion

    // #region scriptRanges
    const scriptRanges = ir.script && collectScriptRanges(ir.script, vueCompilerOptions);
    // #endregion

    // #region scriptSetupRanges
    const scriptSetupRanges = ir.scriptSetup && collectScriptSetupRanges(ir.scriptSetup, vueCompilerOptions);
    // #endregion

    // #region setupConsts
    const setupConsts = new Set<string>();
    if (ir.scriptSetup && scriptSetupRanges) {
        for (const range of scriptSetupRanges.components) {
            setupConsts.add(ir.scriptSetup.content.slice(range.start, range.end));
        }
        if (ir.script && scriptRanges) {
            for (const range of scriptRanges.components) {
                setupConsts.add(ir.script.content.slice(range.start, range.end));
            }
        }
    }
    if (scriptSetupRanges?.defineProps) {
        const { destructured, destructuredRest } = scriptSetupRanges.defineProps;
        if (destructured) {
            for (const name of destructured) {
                setupConsts.add(name);
            }
        }
        if (destructuredRest) {
            setupConsts.add(destructuredRest);
        }
    }
    // #endregion

    // #region setupRefs
    const setupRefs = new Set(
        scriptSetupRanges?.useTemplateRef.map(({ name }) => name).filter((name) => name !== void 0),
    );
    // #endregion

    // #region inheritAttrs
    const inheritAttrs = (
        scriptSetupRanges?.defineOptions?.inheritAttrs ?? scriptRanges?.exportDefault?.options?.inheritAttrs
    ) !== false;
    // #endregion

    // #region componentName
    let componentName: string;
    if (ir.script && scriptRanges?.exportDefault?.options?.name) {
        const { name } = scriptRanges.exportDefault.options;
        componentName = ir.script.content.slice(name.start + 1, name.end - 1);
    }
    else if (ir.scriptSetup && scriptSetupRanges?.defineOptions?.name) {
        componentName = scriptSetupRanges.defineOptions.name;
    }
    else {
        componentName = basename(ir.fileName, extname(ir.fileName));
    }
    componentName = capitalize(camelize(componentName));
    // #endregion

    // #region generatedTemplate
    const generatedTemplate = ir.template && !vueCompilerOptions.skipTemplateCodegen
        ? generateTemplate({
            vueCompilerOptions,
            template: ir.template,
            setupConsts,
            setupRefs,
            hasDefineSlots: scriptSetupRanges?.defineSlots !== void 0,
            propsAssignName: scriptSetupRanges?.defineProps?.name,
            slotsAssignName: scriptSetupRanges?.defineSlots?.name,
            componentName,
            inheritAttrs,
        })
        : void 0;
    // #endregion

    // #region generatedStyle
    const generatedStyle = ir.styles.length && !vueCompilerOptions.skipTemplateCodegen
        ? generateStyle({
            vueCompilerOptions,
            styles: ir.styles,
            setupConsts,
            setupRefs,
        })
        : void 0;
    // #endregion

    // #region declaredVariables
    const declaredVariables = new Set<string>();
    if (ir.scriptSetup && scriptSetupRanges) {
        for (const range of scriptSetupRanges.bindings) {
            const name = ir.scriptSetup.content.slice(range.start, range.end);
            declaredVariables.add(name);
        }
    }
    if (ir.script && scriptRanges) {
        for (const range of scriptRanges.bindings) {
            const name = ir.script.content.slice(range.start, range.end);
            declaredVariables.add(name);
        }
    }
    // #endregion

    // #region setupExposed
    const setupExposed = new Set<string>();
    for (const name of [
        ...generatedTemplate?.accessedVars ?? [],
        ...generatedTemplate?.dollarVars ?? [],
    ]) {
        if (declaredVariables.has(name)) {
            setupExposed.add(name);
        }
    }
    for (const component of ir.template?.ast.components ?? []) {
        for (const name of new Set([camelize(component), capitalize(camelize(component))])) {
            if (declaredVariables.has(name)) {
                setupExposed.add(name);
            }
        }
    }
    // #endregion

    // #region generatedScript
    const generatedScript = generateScript({
        vueCompilerOptions,
        fileName: ir.fileName,
        script: ir.script,
        scriptSetup: ir.scriptSetup,
        scriptRanges,
        scriptSetupRanges,
        templateAndStyleCodes: [
            ...generatedTemplate?.codes ?? [],
            ...generatedStyle?.codes ?? [],
        ],
        templateAndStyleTypes: new Set([
            ...generatedTemplate?.generatedTypes ?? [],
            ...generatedStyle?.generatedTypes ?? [],
        ]),
        exposed: setupExposed,
    });
    // #endregion

    const imports: Range[] = [];
    for (const [block, ranges] of [
        [ir.script, scriptRanges?.imports],
        [ir.scriptSetup, scriptSetupRanges?.imports],
    ] as const) {
        if (block && ranges?.length) {
            transformImportRanges(
                vueCompilerOptions,
                block.content,
                block.innerStart,
                block.name,
                generatedScript.codes,
                ranges,
            );
            imports.push(...ranges);
        }
    }

    const blocks: Record<string, IRBlock> = {};
    for (const block of [
        ir.template,
        ir.script,
        ir.scriptSetup,
        ...ir.styles,
        ...ir.customBlocks,
    ]) {
        if (block) {
            blocks[block.name] = block;
        }
    }

    const codes = generatedScript.codes.map<Code>((code) => {
        if (typeof code === "string") {
            return code;
        }
        if (code[1] === void 0 || code[1] === "main") {
            return code;
        }
        const block = blocks[code[1]];
        if (!block) {
            return code;
        }
        return [
            code[0],
            void 0,
            code[2] + block.innerStart,
            code[3],
        ];
    });

    const mappings = createMappings(codes);
    const mapper = new SourceMap<CodeInformation>(mappings);

    return {
        type: "virtual",
        fileName,
        sourceText,
        virtualText: toString(codes),
        virtualLang: ir.scriptSetup?.lang ?? ir.script?.lang ?? "ts",
        mapper,
        imports,
        references: [],
    };
}

function createNativeFile(
    fileName: string,
    sourceText: string,
    vueCompilerOptions: VueCompilerOptions,
): SourceFile {
    const { program: ast } = parseSync(fileName, sourceText);

    const codes: Code[] = [];
    const imports = collectImportRanges(ast);
    transformImportRanges(vueCompilerOptions, sourceText, 0, void 0, codes, imports);

    const mappings = createMappings(codes);
    const mapper = new SourceMap<CodeInformation>(mappings);

    return {
        type: "native",
        fileName,
        sourceText,
        virtualText: codes.length > 1 ? toString(codes) : void 0,
        mapper,
        imports,
        references: [],
    };
}

function transformImportRanges(
    vueCompilerOptions: VueCompilerOptions,
    sourceText: string,
    sourceStart: number,
    source: string | undefined,
    codes: Code[],
    imports: Range[],
) {
    for (const range of imports) {
        const text = sourceText.slice(range.start + 1, range.end - 1);
        if (vueCompilerOptions.extensions.some((ext) => text.endsWith(ext))) {
            replaceSourceRange(codes, source, range.end - 1, range.end - 1, `    `);
        }
        range.start += sourceStart;
        range.end += sourceStart;
    }
}

function createMappings(codes: Code[]) {
    const originalMappings: Mapping<CodeInformation>[] = [];

    let length = 0;
    for (const code of codes) {
        if (typeof code === "string") {
            length += code.length;
            continue;
        }
        else {
            originalMappings.push({
                sourceOffsets: [code[2]],
                generatedOffsets: [length],
                lengths: [code[0].length],
                data: code[3],
            });
            length += code[0].length;
        }
    }

    const mappings: typeof originalMappings = [];
    const tokens: Record<symbol, Mapping> = {};

    for (const mapping of originalMappings) {
        if (mapping.data.__combineToken) {
            const token = mapping.data.__combineToken;
            if (token in tokens) {
                const target = tokens[token];
                target.sourceOffsets.push(...mapping.sourceOffsets);
                target.generatedOffsets.push(...mapping.generatedOffsets);
                target.lengths.push(...mapping.lengths);
            }
            else {
                tokens[token] = mapping;
                mappings.push(mapping);
            }
            continue;
        }
        mappings.push(mapping);
    }
    return mappings;
}

const registries: Record<string, Map<string, SourceFile>> = {};

export function getSourceFileRegistry(vueCompilerOptions: VueCompilerOptions) {
    const key = JSON.stringify(
        Object.keys(vueCompilerOptions)
            .filter((key) => key !== "plugins")
            .sort()
            .map((key) => [key, vueCompilerOptions[key as keyof VueCompilerOptions]]),
    );
    return registries[key] ??= new Map();
}
