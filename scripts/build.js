"use strict";

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const distDir = path.resolve(__dirname, "..", "dist");

// Plugin to shim node-only modules for browser builds
const emptyNodeModulesPlugin = {
    name: "empty-node-modules",
    setup(build) {
        const emptyFilter = /^(fs|path|os|child_process|readline-sync|tmp)$/;
        build.onResolve({ filter: emptyFilter }, (args) => ({
            path: args.path,
            namespace: "empty-node",
        }));
        build.onLoad({ filter: /.*/, namespace: "empty-node" }, () => ({
            contents: "module.exports = {};",
            loader: "js",
        }));
    },
};

const browserFooter = `
if (typeof window !== "undefined") {
  window.fengari = fengari;
}
if (typeof globalThis !== "undefined") {
  globalThis.fengari = fengari;
}
`;

async function build() {
    if (fs.existsSync(distDir)) {
        fs.rmSync(distDir, { recursive: true, force: true });
    }
    fs.mkdirSync(distDir, { recursive: true });

    console.log("Building shaped-fengari bundles...");

    const baseBrowserOptions = {
        entryPoints: [path.resolve(__dirname, "../src/fengari.js")],
        bundle: true,
        platform: "browser",
        target: ["es2020"],
        define: {
            process: "undefined",
        },
        plugins: [emptyNodeModulesPlugin],
        sourcemap: true,
    };

    // 1. Browser standalone bundle (IIFE - unminified)
    await esbuild.build({
        ...baseBrowserOptions,
        format: "iife",
        globalName: "fengari",
        outfile: path.join(distDir, "shaped-fengari.js"),
        footer: { js: browserFooter },
        minify: false,
    });

    // 2. Browser standalone bundle (IIFE - minified)
    await esbuild.build({
        ...baseBrowserOptions,
        format: "iife",
        globalName: "fengari",
        outfile: path.join(distDir, "shaped-fengari.min.js"),
        footer: { js: browserFooter },
        minify: true,
    });

    // 3. Browser / Bundler ESM (unminified)
    await esbuild.build({
        ...baseBrowserOptions,
        entryPoints: [path.resolve(__dirname, "../src/index-esm.mjs")],
        format: "esm",
        outfile: path.join(distDir, "shaped-fengari.mjs"),
        minify: false,
    });

    // 4. Browser / Bundler ESM (minified)
    await esbuild.build({
        ...baseBrowserOptions,
        entryPoints: [path.resolve(__dirname, "../src/index-esm.mjs")],
        format: "esm",
        outfile: path.join(distDir, "shaped-fengari.min.mjs"),
        minify: true,
    });

    // Copy .esm.js compatibility aliases
    fs.copyFileSync(
        path.join(distDir, "shaped-fengari.mjs"),
        path.join(distDir, "shaped-fengari.esm.js")
    );
    fs.copyFileSync(
        path.join(distDir, "shaped-fengari.mjs.map"),
        path.join(distDir, "shaped-fengari.esm.js.map")
    );
    fs.copyFileSync(
        path.join(distDir, "shaped-fengari.min.mjs"),
        path.join(distDir, "shaped-fengari.esm.min.js")
    );
    fs.copyFileSync(
        path.join(distDir, "shaped-fengari.min.mjs.map"),
        path.join(distDir, "shaped-fengari.esm.min.js.map")
    );

    // 5. Node CommonJS bundle
    await esbuild.build({
        entryPoints: [path.resolve(__dirname, "../src/fengari.js")],
        bundle: true,
        platform: "node",
        target: ["node20"],
        format: "cjs",
        outfile: path.join(distDir, "shaped-fengari.cjs"),
        external: ["fs", "path", "os", "child_process", "readline-sync", "tmp", "sprintf-js"],
        sourcemap: true,
        minify: false,
    });

    // 6. Upstream fengari drop-in aliases for seamless compatibility
    fs.copyFileSync(
        path.join(distDir, "shaped-fengari.js"),
        path.join(distDir, "fengari.js")
    );
    fs.copyFileSync(
        path.join(distDir, "shaped-fengari.js.map"),
        path.join(distDir, "fengari.js.map")
    );
    fs.copyFileSync(
        path.join(distDir, "shaped-fengari.min.js"),
        path.join(distDir, "fengari.min.js")
    );
    fs.copyFileSync(
        path.join(distDir, "shaped-fengari.min.js.map"),
        path.join(distDir, "fengari.min.js.map")
    );

    console.log("\nBuild completed successfully! Generated artifacts:");
    const files = fs.readdirSync(distDir);
    for (const file of files) {
        const stat = fs.statSync(path.join(distDir, file));
        const sizeKb = (stat.size / 1024).toFixed(1);
        console.log(`  - dist/${file.padEnd(28)} (${sizeKb} KB)`);
    }
}

build().catch((err) => {
    console.error("Build failed:", err);
    process.exit(1);
});
