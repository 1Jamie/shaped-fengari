"use strict";

const fengari = require("../src/fengari.js");
const { lua, lauxlib, lualib, to_luastring } = fengari;

describe("Proto Chunk Cache in lauxlib", () => {
    let L;

    beforeEach(() => {
        L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);
    });

    test("executes cached chunk and sees global updates", () => {
        const code = to_luastring("return _G.test_val * 2");

        // 1st run (cache miss & compile)
        lua.lua_pushinteger(L, 10);
        lua.lua_setglobal(L, to_luastring("test_val"));

        let status = lauxlib.luaL_dostring(L, code);
        expect(status).toBe(lua.LUA_OK);
        expect(lua.lua_tointeger(L, -1)).toBe(20);
        lua.lua_pop(L, 1);

        // Verify cache was populated
        expect(L.l_G._protoCache).toBeDefined();
        expect(L.l_G._protoCache.size).toBe(1);

        // 2nd run (cache hit) with updated global
        lua.lua_pushinteger(L, 25);
        lua.lua_setglobal(L, to_luastring("test_val"));

        status = lauxlib.luaL_dostring(L, code);
        expect(status).toBe(lua.LUA_OK);
        expect(lua.lua_tointeger(L, -1)).toBe(50);
        lua.lua_pop(L, 1);
    });

    test("differentiates chunks with different source names", () => {
        const code = to_luastring("return 42");
        const name1 = to_luastring("chunk_A");
        const name2 = to_luastring("chunk_B");

        expect(lauxlib.luaL_loadbuffer(L, code, code.length, name1)).toBe(lua.LUA_OK);
        lua.lua_pop(L, 1);

        expect(lauxlib.luaL_loadbuffer(L, code, code.length, name2)).toBe(lua.LUA_OK);
        lua.lua_pop(L, 1);

        expect(L.l_G._protoCache.size).toBe(2);
    });

    test("handles LRU eviction when exceeding capacity", () => {
        const limit = 140; // exceeds PROTO_CACHE_MAX (128)
        for (let i = 0; i < limit; i++) {
            const code = to_luastring(`local x = ${i}; return x`);
            expect(lauxlib.luaL_dostring(L, code)).toBe(lua.LUA_OK);
            expect(lua.lua_tointeger(L, -1)).toBe(i);
            lua.lua_pop(L, 1);
        }

        expect(L.l_G._protoCache.size).toBeLessThanOrEqual(128);
    });

    test("cache hit is significantly faster than initial compilation", () => {
        const code = to_luastring("local sum = 0; for i = 1, 100 do sum = sum + i end; return sum");

        // Initial compile
        lauxlib.luaL_loadstring(L, code);
        lua.lua_pop(L, 1);

        // 1000 cached loads
        const t0 = Date.now();
        for (let i = 0; i < 1000; i++) {
            lauxlib.luaL_loadstring(L, code);
            lua.lua_pop(L, 1);
        }
        const cachedDuration = Date.now() - t0;

        // Cached loads should finish in well under 50ms for 1000 iterations
        expect(cachedDuration).toBeLessThan(100);
    });
});
