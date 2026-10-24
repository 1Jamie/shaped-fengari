"use strict";

const lua = require('../src/lua.js');
const lauxlib = require('../src/lauxlib.js');
const lualib = require('../src/lualib.js');
const { to_luastring } = require('../src/fengaricore.js');

describe('64-bit Integer Parity and Edge Cases', () => {
    let L;

    beforeEach(() => {
        L = lauxlib.luaL_newstate();
        if (!L) throw Error("failed to create lua state");
        lualib.luaL_openlibs(L);
    });

    const runLua = (code) => {
        expect(lauxlib.luaL_loadstring(L, to_luastring(code))).toBe(lua.LUA_OK);
        lua.lua_call(L, 0, -1);
    };

    test('64-bit bitwise shifts across 32-bit boundaries', () => {
        runLua(`
            local a = 1 << 40
            local b = a >> 40
            local c = (0x123456789ABCDEF0 >> 32)
            local d = (0x123456789ABCDEF0 << 32)
            local e = 1 << 64
            local f = 1 << -64
            local g = 1 >> 64
            return a, b, c, d, e, f, g
        `);
        expect(lua.lua_tointeger64(L, -7)).toBe(1n << 40n);
        expect(lua.lua_tointeger64(L, -6)).toBe(1n);
        expect(lua.lua_tointeger64(L, -5)).toBe(0x12345678n);
        expect(lua.lua_tointeger64(L, -4)).toBe(BigInt.asIntN(64, 0x123456789ABCDEF0n << 32n));
        expect(lua.lua_tointeger64(L, -3)).toBe(0n);
        expect(lua.lua_tointeger64(L, -2)).toBe(0n);
        expect(lua.lua_tointeger64(L, -1)).toBe(0n);
    });

    test('Audio DSP sample rate conversion & 64-bit accumulator', () => {
        runLua(`
            -- Emulate 32.32 fixed-point audio sample playback step
            local sampleRateIn = 44100
            local sampleRateOut = 48000
            local step = (sampleRateIn << 32) // sampleRateOut
            local pos = 0
            for i = 1, 100 do
                pos = pos + step
            end
            local wholeIndex = pos >> 32
            local fracPart = pos & 0xFFFFFFFF
            return step, pos, wholeIndex, fracPart
        `);
        const step = (44100n << 32n) / 48000n;
        const pos = step * 100n;
        expect(lua.lua_tointeger64(L, -4)).toBe(step);
        expect(lua.lua_tointeger64(L, -3)).toBe(pos);
        expect(lua.lua_tointeger64(L, -2)).toBe(pos >> 32n);
        expect(lua.lua_tointeger64(L, -1)).toBe(pos & 0xFFFFFFFFn);
    });

    test('Boundary division and modulo: mininteger // -1 and mininteger % -1', () => {
        runLua(`
            local minint = math.mininteger
            local div = minint // -1
            local mod = minint % -1
            return div, mod, div == minint, mod == 0
        `);
        expect(lua.lua_tointeger64(L, -4)).toBe(-9223372036854775808n);
        expect(lua.lua_tointeger64(L, -3)).toBe(0n);
        expect(lua.lua_toboolean(L, -2)).toBe(true);
        expect(lua.lua_toboolean(L, -1)).toBe(true);
    });

    test('Numeric for-loop at mininteger and maxinteger boundaries with 64-bit wrapping', () => {
        runLua(`
            local count = 0
            for i = math.maxinteger - 2, math.maxinteger do
                count = count + 1
                if i == math.maxinteger then break end
            end

            local count2 = 0
            for i = math.mininteger + 2, math.mininteger, -1 do
                count2 = count2 + 1
                if i == math.mininteger then break end
            end

            return count, count2
        `);
        expect(lua.lua_tointeger(L, -2)).toBe(3);
        expect(lua.lua_tointeger(L, -1)).toBe(3);
    });

    test('Table indexing with BigInt and equivalent float keys', () => {
        runLua(`
            local t = {}
            local max = math.maxinteger
            t[max] = "maxint"
            t[1] = "first"
            t[1.0] = "first_float"
            return t[max], t[1], t[1.0], #t
        `);
        expect(lua.lua_tojsstring(L, -4)).toBe("maxint");
        expect(lua.lua_tojsstring(L, -3)).toBe("first_float");
        expect(lua.lua_tojsstring(L, -2)).toBe("first_float");
        expect(lua.lua_tointeger(L, -1)).toBe(1);
    });

    test('string.pack and string.unpack with 64-bit and arbitrary-width formats', () => {
        runLua(`
            local val = 0x123456789ABCDEF0
            local packed_j = string.pack("j", val)
            local unpacked_j = string.unpack("j", packed_j)

            local packed_i5 = string.pack("i5", 0x123456789A)
            local unpacked_i5 = string.unpack("i5", packed_i5)

            local packed_I8 = string.pack("I8", 0xFFFFFFFFFFFFFFFF)
            local unpacked_I8 = string.unpack("I8", packed_I8)

            return unpacked_j == val, unpacked_i5 == 0x123456789A, unpacked_I8 == -1
        `);
        expect(lua.lua_toboolean(L, -3)).toBe(true);
        expect(lua.lua_toboolean(L, -2)).toBe(true);
        expect(lua.lua_toboolean(L, -1)).toBe(true);
    });

    test('Bytecode dump and load roundtrip with 64-bit constants', () => {
        runLua(`
            local function make_calc()
                return function(x)
                    return x + 0x7FFFFFFFFFFFFFFF
                end
            end
            local f = make_calc()
            local dumped = string.dump(f)
            local loaded = load(dumped)
            return loaded(1) == math.mininteger
        `);
        expect(lua.lua_toboolean(L, -1)).toBe(true);
    });

    test('Host API: lua_tointeger vs lua_tointeger64', () => {
        runLua(`return math.maxinteger, 42`);
        // lua_tointeger returns JS number
        expect(typeof lua.lua_tointeger(L, -1)).toBe('number');
        expect(lua.lua_tointeger(L, -1)).toBe(42);

        // lua_tointeger64 returns BigInt
        expect(typeof lua.lua_tointeger64(L, -1)).toBe('bigint');
        expect(lua.lua_tointeger64(L, -1)).toBe(42n);

        expect(typeof lua.lua_tointeger64(L, -2)).toBe('bigint');
        expect(lua.lua_tointeger64(L, -2)).toBe(9223372036854775807n);
    });
});
