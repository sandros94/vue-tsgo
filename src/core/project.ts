import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { stripVTControlCharacters, styleText } from "node:util";
import * as pkg from "empathic/package";
import { detectPackageManager } from "nypm";
import { dirname, join, relative, resolve } from "pathe";
import { glob } from "tinyglobby";
import { parse } from "tsconfck";
import { $ } from "zx";
import packageJson from "../../package.json";
import { createSourceFile, type SourceFile } from "./codegen";
import { createCompilerOptionsResolver } from "./compilerOptions";
import type { CodeInformation } from "./types";

export interface Project {
    getSourceFile: (fileName: string) => SourceFile | undefined;
    check: () => Promise<boolean>;
}

export async function createProject(configPath: string): Promise<Project> {
    const parsed = await parse(configPath);
    const configRoot = dirname(configPath);
    const configHash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);

    const cacheRoot = pkg.cache(`${packageJson.name}/${configHash}`, {
        cwd: configRoot,
    })!;
    if (cacheRoot === void 0) {
        throw new Error("[Vue] Failed to find or create cache directory.");
    }

    const resolver = createCompilerOptionsResolver();
    for (const extended of parsed.extended?.toReversed() ?? []) {
        if ("vueCompilerOptions" in extended.tsconfig) {
            resolver.add(extended.tsconfig.vueCompilerOptions, dirname(extended.tsconfigFile));
        }
    }
    const vueCompilerOptions = resolver.resolve();
    const sourceToTarget = new Map<string, SourceFile>();
    const targetToSource = new Map<string, SourceFile>();

    const { includes, excludes } = await resolveFiles(parsed.tsconfig, configRoot);
    const includeSet = new Set(Object.values(includes).flat());
    const excludeSet = new Set(Object.values(excludes).flat());
    const mutualRoot = getMutualRoot(Object.keys(includes), configRoot);

    for (const path of includeSet) {
        await processFile(path);
    }

    async function processFile(path: string) {
        if (excludeSet.has(path)) {
            includeSet.delete(path);
            return;
        }

        if (sourceToTarget.has(path)) {
            return;
        }

        const sourceText = await readFile(path, "utf-8");
        const targetPath = join(cacheRoot, relative(mutualRoot, path));
        const sourceFile = createSourceFile(path, targetPath, sourceText, vueCompilerOptions);
        sourceToTarget.set(path, sourceFile);
        targetToSource.set(targetPath, sourceFile);

        for (const path of sourceFile.references) {
            includeSet.add(path);
        }
    }

    function getSourceFile(fileName: string) {
        return sourceToTarget.get(fileName);
    }

    async function generate() {
        await rm(cacheRoot, { recursive: true, force: true });
        await mkdir(cacheRoot, { recursive: true });

        for (const path of includeSet) {
            const sourceFile = getSourceFile(path)!;

            await mkdir(dirname(sourceFile.targetPath), { recursive: true });
            if (sourceFile.virtualText !== void 0) {
                let { virtualText } = sourceFile;
                for (const range of sourceFile.imports) {
                    const imported = join(dirname(path), sourceFile.sourceText.slice(range.start + 1, range.end - 1));
                    if (imported !== void 0) {
                        const importedFile = sourceToTarget.get(imported);
                        if (importedFile?.type === "virtual") {
                            // eslint-disable-next-line no-unreachable-loop
                            for (const [offset] of sourceFile.mapper.toGeneratedLocation(range.end - 1)) {
                                virtualText = virtualText!.slice(0, offset)
                                    + `.${importedFile.virtualLang}`.padStart(4, "_")
                                    + virtualText!.slice(offset + 4);
                                break;
                            }
                        }
                    }
                }
                await writeFile(sourceFile.targetPath, virtualText);
            }
            else {
                await symlink(path, sourceFile.targetPath);
            }
        }

        const targetConfigPath = join(cacheRoot, relative(mutualRoot, configPath));
        const targetConfig = {
            ...parsed.tsconfig,
            extends: void 0,
        };
        await mkdir(dirname(targetConfigPath), { recursive: true });
        await writeFile(targetConfigPath, JSON.stringify(targetConfig, null, 2));

        if (dirname(targetConfigPath) !== cacheRoot) {
            const stubConfigPath = join(cacheRoot, "tsconfig.json");
            const stubConfig = {
                references: [{ path: "./" + relative(cacheRoot, targetConfigPath) }],
                files: [],
            };
            await writeFile(stubConfigPath, JSON.stringify(stubConfig, null, 2));
        }
    }

    async function check() {
        await generate();
        const packageManager = await detectPackageManager(configRoot);
        const command = packageManager?.name !== "npm" ? "npx" : packageManager.name;

        const { stdout } = await $({ nothrow: true })`
            ${command} tsgo --project ${cacheRoot}/tsconfig.json --pretty true
        `;

        const groups = parseDiagnostics(stripVTControlCharacters(stdout));
        let withoutError = true;

        for (let [path, diagnostics] of Object.entries(groups)) {
            const sourceFile = targetToSource.get(path);

            for (let i = 0; i < diagnostics.length; i++) {
                const diagnostic = diagnostics[i];

                if (!sourceFile) {
                    if (path.startsWith(cacheRoot)) {
                        path = path.replace(cacheRoot, mutualRoot);
                    }
                    continue;
                }
                path = sourceFile.sourcePath;

                const start = sourceFile.getVirtualOffset(
                    diagnostic.start.line,
                    diagnostic.start.column,
                );
                const end = sourceFile.getVirtualOffset(
                    diagnostic.end.line,
                    diagnostic.end.column,
                );

                let left: number | undefined;
                // eslint-disable-next-line no-unreachable-loop
                for (const [offset] of sourceFile.mapper.toSourceLocation(
                    Number(start),
                    (data) => isVerificationEnabled(data, diagnostic.code),
                )) {
                    left = offset;
                    break;
                }

                let right: number | undefined;
                // eslint-disable-next-line no-unreachable-loop
                for (const [offset] of sourceFile.mapper.toSourceLocation(
                    Number(end),
                    (data) => isVerificationEnabled(data, diagnostic.code),
                )) {
                    right = offset;
                    break;
                }

                if (!left || !right) {
                    diagnostics.splice(i--, 1);
                    continue;
                }

                diagnostic.start = sourceFile.getSourceLineAndColumn(left);
                diagnostic.end = sourceFile.getSourceLineAndColumn(right);
            }

            const relativePath = relative(process.cwd(), path);
            const sourceText = sourceFile?.sourceText ?? await readFile(path, "utf-8");
            const lines = sourceText.split("\n");

            for (const { start, end, code, message } of diagnostics) {
                console.info(`${styleText("cyanBright", relativePath)}:${styleText("yellowBright", String(start.line))}:${styleText("yellowBright", String(start.column))} - ${styleText("redBright", "error")} ${styleText("gray", `TS${code}:`)} ${message}\n`);

                const padding = String(end.line).length;
                const printedLines = lines.slice(start.line - 1, end.line);

                for (let i = 0; i < printedLines.length; i++) {
                    const line = printedLines[i];
                    const columnStart = i === 0 ? start.column - 1 : 0;
                    const columnEnd = i === printedLines.length - 1 ? end.column - 1 : line.length;

                    console.info(`\x1B[7m${start.line + i}\x1B[0m ${line}`);
                    console.info(`\x1B[7m${" ".repeat(padding)}\x1B[0m ${" ".repeat(columnStart)}${styleText("redBright", "~".repeat(columnEnd - columnStart))}\n`);
                }
                withoutError = false;
            }
        }

        return withoutError;
    }

    interface Diagnostic {
        path: string;
        start: {
            line: number;
            column: number;
        };
        end: {
            line: number;
            column: number;
        };
        code: number;
        message: string;
    }

    const diagnosticRE = /^(?<path>.*?):(?<line>\d+):(?<column>\d+) - error TS(?<code>\d+): (?<message>.*)$/;

    function parseDiagnostics(stdout: string) {
        const diagnostics: Diagnostic[] = [];
        const lines = stdout.trim().split("\n");

        let cursor = 0;
        let padding = 0;

        for (let i = 0; i < lines.length; i++) {
            const text = lines[i];
            const match = text.match(diagnosticRE);

            if (match) {
                const { path, line, column, code, message } = match.groups!;
                diagnostics.push({
                    path: resolve(path),
                    code: Number(code),
                    start: {
                        line: Number(line),
                        column: Number(column),
                    },
                    end: {
                        line: 0,
                        column: 0,
                    },
                    message,
                });
                cursor = 0;
            }
            else if (cursor % 2 === 0 && text.length) {
                padding = text.split(" ", 1)[0].length;
            }
            else if (cursor % 2 === 1 && text.includes("~")) {
                const diagnostic = diagnostics.at(-1)!;
                diagnostic.end = {
                    line: diagnostic.start.line + (cursor - 3) / 2,
                    column: text.lastIndexOf("~") + 1 - padding,
                };
            }
            cursor++;
        }

        const groups: Record<string, typeof diagnostics> = {};
        for (const diagnostic of diagnostics) {
            let group = groups[diagnostic.path];
            if (!group) {
                groups[diagnostic.path] = group = [];
            }
            group.push(diagnostic);
        }
        return groups;
    }

    return {
        getSourceFile,
        check,
    };
}

async function resolveFiles(config: any, configRoot: string) {
    const [includes, excludes] = await Promise.all([
        config.include?.map(resolve),
        config.exclude?.map(resolve),
    ].map((tasks) => (tasks ? Promise.all(tasks) : [])));

    return {
        includes: Object.fromEntries<string[]>(includes),
        excludes: Object.fromEntries<string[]>(excludes),
    };

    async function resolve(pattern: string) {
        const originalKey = pattern;
        if (!pattern.includes("*")) {
            try {
                const path = join(configRoot, pattern);
                const stats = await stat(path);
                if (stats.isFile()) {
                    return [originalKey, [path]];
                }
            }
            catch {}
            pattern = join(pattern, "**/*");
        }

        const files = await glob(pattern, {
            absolute: true,
            cwd: configRoot,
            ignore: "**/node_modules/**",
        });
        return [originalKey, files];
    }
}

function getMutualRoot(patterns: string[], configRoot: string) {
    let upwardLevel = 0;
    for (let pattern of patterns) {
        let level = 0;
        while (pattern.startsWith("../")) {
            pattern = pattern.slice(3);
            level++;
        }
        if (upwardLevel < level) {
            upwardLevel = level;
        }
    }
    return join(configRoot, ...Array.from({ length: upwardLevel }, () => ".."));
}

function isVerificationEnabled(data: CodeInformation, code: number) {
    return data.verification === true ||
        typeof data.verification === "object" &&
        data.verification.shouldReport?.(code) === true;
}
