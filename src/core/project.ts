import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as pkg from "empathic/package";
import { dirname, join, relative } from "pathe";
import { glob } from "tinyglobby";
import { parse } from "tsconfck";
import packageJson from "../../package.json";
import { createSourceFile, getSourceFileRegistry, type SourceFile } from "./codegen";
import { createCompilerOptionsResolver } from "./compilerOptions";

export interface Project {
    getSourceFile: (fileName: string) => SourceFile | undefined;
    emit: () => Promise<void>;
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

        const registry = getSourceFileRegistry(vueCompilerOptions);
        if (registry.has(path)) {
            return;
        }

        const sourceText = await readFile(path, "utf-8");
        const targetPath = join(cacheRoot, relative(mutualRoot, path));
        const sourceFile = createSourceFile(path, targetPath, sourceText, vueCompilerOptions);
        registry.set(path, sourceFile);

        for (const path of sourceFile.references) {
            includeSet.add(path);
        }
    }

    function getSourceFile(fileName: string) {
        const registry = getSourceFileRegistry(vueCompilerOptions);
        return registry.get(fileName);
    }

    async function emit() {
        await rm(cacheRoot, { recursive: true, force: true });
        await mkdir(cacheRoot, { recursive: true });

        for (const path of includeSet) {
            const registry = getSourceFileRegistry(vueCompilerOptions);
            const sourceFile = registry.get(path)!;

            await mkdir(dirname(sourceFile.fileName), { recursive: true });
            if (sourceFile.virtualText !== void 0) {
                let { virtualText } = sourceFile;
                for (const range of sourceFile.imports) {
                    const imported = join(dirname(path), sourceFile.sourceText.slice(range.start + 1, range.end - 1));
                    if (imported !== void 0) {
                        const importedFile = registry.get(imported);
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
                const targetPath = sourceFile.virtualLang
                    ? sourceFile.fileName + `.${sourceFile.virtualLang}`.padStart(4, "_")
                    : sourceFile.fileName;
                await writeFile(targetPath, virtualText);
            }
            else {
                await symlink(path, sourceFile.fileName);
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

    return {
        getSourceFile,
        emit,
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
