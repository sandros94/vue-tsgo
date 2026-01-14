import { defineConfig } from "tsdown";

export default defineConfig([{
    exports: true,
}, {
    entry: {
        cli: "./src/cli/index.ts",
    },
    dts: false,
    banner: "#!/usr/bin/env node",
}]);
