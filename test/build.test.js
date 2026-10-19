"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

describe("Build Artifacts", () => {
    const rootDir = path.resolve(__dirname, "..");
    const distDir = path.join(rootDir, "dist");

    beforeAll(() => {
    // Ensure build has been run
        execFileSync(process.execPath, [path.join(rootDir, "scripts", "build.js")], {
            cwd: rootDir,
            stdio: "pipe",
        });
    });

    const expectedFiles = [
        "shaped-fengari.js",
        "shaped-fengari.js.map",
        "shaped-fengari.min.js",
        "shaped-fengari.min.js.map",
        "shaped-fengari.mjs",
        "shaped-fengari.mjs.map",
        "shaped-fengari.min.mjs",
        "shaped-fengari.min.mjs.map",
        "shaped-fengari.esm.js",
        "shaped-fengari.esm.min.js",
        "shaped-fengari.cjs",
        "shaped-fengari.cjs.map",
        "fengari.js",
        "fengari.min.js",
    ];

    test.each(expectedFiles)("generates non-empty file %s", (filename) => {
        const filePath = path.join(distDir, filename);
        expect(fs.existsSync(filePath)).toBe(true);
        const stat = fs.statSync(filePath);
        expect(stat.size).toBeGreaterThan(0);
    });

    test("unminified browser bundle runs in browser window environment", () => {
        const code = fs.readFileSync(path.join(distDir, "shaped-fengari.js"), "utf8");
        const mockWindow = {};
        const runner = new Function("window", code);
        runner(mockWindow);

        expect(mockWindow.fengari).toBeDefined();
        const { lua, lauxlib, lualib, to_luastring } = mockWindow.fengari;

        const L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        const status = lauxlib.luaL_dostring(L, to_luastring("return 21 * 2"));
        expect(status).toBe(0);
        const result = lua.lua_tointeger(L, -1);
        expect(result).toBe(42);
    });

    test("minified browser bundle runs in browser window environment", () => {
        const code = fs.readFileSync(path.join(distDir, "shaped-fengari.min.js"), "utf8");
        const mockWindow = {};
        const runner = new Function("window", code);
        runner(mockWindow);

        expect(mockWindow.fengari).toBeDefined();
        const { lua, lauxlib, lualib, to_luastring } = mockWindow.fengari;

        const L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        const status = lauxlib.luaL_dostring(L, to_luastring("return 'hello' .. ' ' .. 'world'"));
        expect(status).toBe(0);
        const result = lua.lua_tojsstring(L, -1);
        expect(result).toBe("hello world");
    });

    test("Node CommonJS bundle exports expected API", () => {
        const fengari = require(path.join(distDir, "shaped-fengari.cjs"));
        expect(fengari.lua).toBeDefined();
        expect(fengari.lauxlib).toBeDefined();
        expect(fengari.lualib).toBeDefined();
        expect(fengari.to_luastring).toBeDefined();

        const L = fengari.lauxlib.luaL_newstate();
        fengari.lualib.luaL_openlibs(L);
        const status = fengari.lauxlib.luaL_dostring(L, fengari.to_luastring("return 123 + 456"));
        expect(status).toBe(0);
        expect(fengari.lua.lua_tointeger(L, -1)).toBe(579);
    });

    test("ESM bundle exports named APIs and default export", () => {
        const esmTestScript = `
      import mod, { lua, lauxlib, lualib, to_luastring } from "./dist/shaped-fengari.mjs";
      if (!lua || !lauxlib || !lualib || !to_luastring || !mod.lua) {
        throw new Error("Missing export");
      }
      const L = lauxlib.luaL_newstate();
      lualib.luaL_openlibs(L);
      const status = lauxlib.luaL_dostring(L, to_luastring("return 7 * 8"));
      if (status !== 0) throw new Error("Execution failed");
      const res = lua.lua_tointeger(L, -1);
      if (res !== 56) throw new Error("Incorrect result: " + res);
      console.log("ESM_OK");
    `;
        const output = execFileSync(
            process.execPath,
            ["--input-type=module", "-e", esmTestScript],
            { cwd: rootDir, encoding: "utf8" }
        );
        expect(output.trim()).toBe("ESM_OK");
    });
});
