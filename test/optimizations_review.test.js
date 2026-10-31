"use strict";

const lua = require('../src/lua.js');
const lauxlib = require('../src/lauxlib.js');
const lualib = require('../src/lualib.js');
const { to_luastring } = require('../src/fengaricore.js');

describe('Optimization Component 1: OP_SETLIST & Sequential Integer Keys', () => {
    test('Sequential table with >10,000 entries stays in array slab without spilling into Map', () => {
        let L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        let code = `
            local t = {}
            for i = 1, 25000 do
                t[i] = i * 2
            end
            assert(#t == 25000)
            assert(t[1] == 2)
            assert(t[10000] == 20000)
            assert(t[25000] == 50000)
            return t
        `;
        expect(lauxlib.luaL_dostring(L, to_luastring(code))).toBe(lua.LUA_OK);

        // Inspect internal Table representation
        let tv = L.stack.getTValue(L.top - 1);
        let tableObj = tv.value;
        expect(tableObj.asize).toBeGreaterThanOrEqual(25000);
        // _strong must be null or empty
        expect(!tableObj._strong || tableObj._strong.size === 0).toBe(true);
    });

    test('Guardrail: Sparse write (t[1000000] = true) on empty table must not allocate 1M slot array', () => {
        let L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        let code = `
            local t = {}
            t[1000000] = true
            assert(t[1000000] == true)
            return t
        `;
        expect(lauxlib.luaL_dostring(L, to_luastring(code))).toBe(lua.LUA_OK);

        let tableObj = L.stack.getTValue(L.top - 1).value;
        // Asize must remain 0 or small, sparse key must be in hash part
        expect(tableObj.asize).toBeLessThan(100);
        expect(tableObj._strong).not.toBeNull();
        expect(tableObj._strong.size).toBe(1);
    });

    test('OP_SETLIST executes and pre-sizes table properly', () => {
        let L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        let items = Array.from({ length: 150 }, (_, i) => i + 1).join(', ');
        let code = `
            local t = { ${items} }
            assert(#t == 150)
            assert(t[1] == 1)
            assert(t[150] == 150)
            return t
        `;
        expect(lauxlib.luaL_dostring(L, to_luastring(code))).toBe(lua.LUA_OK);

        let tableObj = L.stack.getTValue(L.top - 1).value;
        expect(tableObj.asize).toBeGreaterThanOrEqual(150);
        expect(!tableObj._strong || tableObj._strong.size === 0).toBe(true);
    });
});

describe('Optimization Component 2: Fast Host Intrinsics (string.byte & string.sub)', () => {
    test('string.byte fast path with single argument', () => {
        let L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        let code = `
            local s = "ABCDE"
            assert(string.byte(s) == 65)
            assert(string.byte(s, 1) == 65)
            assert(string.byte(s, 3) == 67)
            assert(string.byte(s, 5) == 69)
            assert(string.byte(s, 6) == nil)
        `;
        expect(lauxlib.luaL_dostring(L, to_luastring(code))).toBe(lua.LUA_OK);
    });

    test('string.byte multi-return and negative indices fall through correctly', () => {
        let L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        let code = `
            local s = "ABCDE"
            -- negative index
            assert(string.byte(s, -1) == 69)
            -- range returns multiple values
            local b1, b2, b3 = string.byte(s, 1, 3)
            assert(b1 == 65 and b2 == 66 and b3 == 67)
        `;
        expect(lauxlib.luaL_dostring(L, to_luastring(code))).toBe(lua.LUA_OK);
    });

    test('string.sub fast path with positive 1-based bounds', () => {
        let L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        let code = `
            local s = "Hello World"
            assert(string.sub(s, 1, 5) == "Hello")
            assert(string.sub(s, 7) == "World")
            assert(string.sub(s, 1, 1) == "H")
            assert(string.sub(s, 3, 2) == "")
        `;
        expect(lauxlib.luaL_dostring(L, to_luastring(code))).toBe(lua.LUA_OK);
    });

    test('string.sub with negative indices falls through correctly', () => {
        let L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        let code = `
            local s = "Hello World"
            assert(string.sub(s, -5) == "World")
            assert(string.sub(s, 1, -7) == "Hello")
        `;
        expect(lauxlib.luaL_dostring(L, to_luastring(code))).toBe(lua.LUA_OK);
    });
});

describe('Optimization Component 3: Native Buffer Backing', () => {
    test('lua_pushlstring creates zero-copy slices that match string equality', () => {
        let L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        let u8 = new Uint8Array([104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100]); // "hello world"
        let sub = u8.subarray(0, 5); // "hello"
        lua.lua_pushlstring(L, sub, 5);
        lua.lua_setglobal(L, to_luastring("my_str"));

        let code = `
            assert(my_str == "hello")
            assert(#my_str == 5)
            assert(string.sub(my_str, 1, 3) == "hel")
        `;
        expect(lauxlib.luaL_dostring(L, to_luastring(code))).toBe(lua.LUA_OK);
    });
});

describe('Host string pushes stay immutable', () => {
    test('lua_pushlstring copies the host buffer', () => {
        let L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        let buf = new Uint8Array([65, 66, 67]);
        lua.lua_pushlstring(L, buf, buf.length);
        buf[0] = 90;

        expect(lua.lua_tojsstring(L, -1)).toBe('ABC');
    });

    test('collectgarbage reports that the host collector is not driven', () => {
        let L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);
        expect(lauxlib.luaL_dostring(L, to_luastring('collectgarbage("collect")'))).not.toBe(lua.LUA_OK);
    });
});
