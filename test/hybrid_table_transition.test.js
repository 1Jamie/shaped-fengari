"use strict";

const lua = require('../src/lua.js');
const lauxlib = require('../src/lauxlib.js');
const lualib = require('../src/lualib.js');
const { to_luastring } = require("../src/defs.js");

function runLua(code) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const status = lauxlib.luaL_dostring(L, to_luastring(code));
    if (status !== lua.LUA_OK) {
        const err = lua.lua_tojsstring(L, -1);
        lua.lua_close(L);
        throw new Error(err);
    }
    const res = lua.lua_tojsstring(L, -1);
    lua.lua_close(L);
    return res;
}

describe("Hybrid table storage (8 to 9 slot transition and operations)", () => {

    test("sequential growth: #t, element access across 7 -> 8 -> 9 -> 16", () => {
        const code = `
            local t = {}
            local log = {}
            for i = 1, 16 do
                t[i] = i * 10
                table.insert(log, #t .. ":" .. t[i])
            end
            return table.concat(log, ",")
        `;
        const res = runLua(code);
        expect(res).toBe("1:10,2:20,3:30,4:40,5:50,6:60,7:70,8:80,9:90,10:100,11:110,12:120,13:130,14:140,15:150,16:160");
    });

    test("table.insert: appending past 8 into 9", () => {
        const code = `
            local t = {1, 2, 3, 4, 5, 6, 7, 8}
            assert(#t == 8)
            table.insert(t, 999)
            assert(#t == 9)
            assert(t[8] == 8 and t[9] == 999)
            table.insert(t, 1000)
            assert(#t == 10)
            return table.concat(t, ",")
        `;
        expect(runLua(code)).toBe("1,2,3,4,5,6,7,8,999,1000");
    });

    test("table.insert: interior insertion shifting elements across 8 -> 9", () => {
        const code = `
            local t = {10, 20, 30, 40, 50, 60, 70, 80}
            assert(#t == 8)
            table.insert(t, 5, 45) -- insert at position 5
            assert(#t == 9)
            assert(t[4] == 40 and t[5] == 45 and t[6] == 50 and t[9] == 80)
            return table.concat(t, ",")
        `;
        expect(runLua(code)).toBe("10,20,30,40,45,50,60,70,80");
    });

    test("table.remove: shrinking across 9 -> 8 -> 7", () => {
        const code = `
            local t = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
            assert(#t == 10)
            local r1 = table.remove(t) -- removes 10
            assert(r1 == 10 and #t == 9)
            local r2 = table.remove(t) -- removes 9 (now size 8)
            assert(r2 == 9 and #t == 8)
            local r3 = table.remove(t, 5) -- interior remove of 5 (now size 7)
            assert(r3 == 5 and #t == 7)
            return table.concat(t, ",")
        `;
        expect(runLua(code)).toBe("1,2,3,4,6,7,8");
    });

    test("table.unpack across boundary", () => {
        const code = `
            local t8 = {1, 2, 3, 4, 5, 6, 7, 8}
            local a, b, c, d, e, f, g, h = table.unpack(t8)
            assert(a == 1 and h == 8)

            local t9 = {1, 2, 3, 4, 5, 6, 7, 8, 9}
            local u1, u2, u3, u4, u5, u6, u7, u8, u9 = table.unpack(t9)
            assert(u1 == 1 and u8 == 8 and u9 == 9)

            local part = { table.unpack(t9, 4, 9) }
            return table.concat(part, ",")
        `;
        expect(runLua(code)).toBe("4,5,6,7,8,9");
    });

    test("table.sort on sizes 7, 8, 9, 10, 16", () => {
        const code = `
            local results = {}
            for _, size in ipairs({7, 8, 9, 10, 16}) do
                local t = {}
                for i = 1, size do t[i] = size - i + 1 end
                table.sort(t)
                table.insert(results, table.concat(t, "-"))
            end
            return table.concat(results, ";")
        `;
        expect(runLua(code)).toBe("1-2-3-4-5-6-7;1-2-3-4-5-6-7-8;1-2-3-4-5-6-7-8-9;1-2-3-4-5-6-7-8-9-10;1-2-3-4-5-6-7-8-9-10-11-12-13-14-15-16");
    });

    test("next / pairs / ipairs iteration across transition", () => {
        const code = `
            local t = {10, 20, 30, 40, 50, 60, 70, 80}
            t[9] = 90
            t["extra"] = "foo"

            local keys = {}
            for k, v in pairs(t) do
                table.insert(keys, tostring(k))
            end
            table.sort(keys)

            local ikeys = {}
            for i, v in ipairs(t) do
                table.insert(ikeys, i .. ":" .. v)
            end

            return table.concat(keys, ",") .. "|" .. table.concat(ikeys, ",")
        `;
        expect(runLua(code)).toBe("1,2,3,4,5,6,7,8,9,extra|1:10,2:20,3:30,4:40,5:50,6:60,7:70,8:80,9:90");
    });

    test("boundary removals (t[k] = nil) and border search (#t)", () => {
        const code = `
            local t = {1, 2, 3, 4, 5, 6, 7, 8, 9}
            assert(#t == 9)
            t[9] = nil
            assert(#t == 8)
            t[8] = nil
            assert(#t == 7)
            t[5] = nil -- create hole inside array part
            local len = #t
            assert(len == 4 or len == 7) -- valid Lua 5.3 border condition (either side of hole)
            return tostring(len)
        `;
        const res = runLua(code);
        expect(res === "4" || res === "7").toBe(true);
    });

    test("64-bit integer values > 32 bits across 8 -> 9 transition", () => {
        const code = `
            local big = 10000000000 -- 10 billion (exceeds 32-bit signed integer)
            local t = {big, big + 1, big + 2, big + 3, big + 4, big + 5, big + 6, big + 7}
            assert(t[1] == big and t[8] == big + 7)
            t[9] = big + 8 -- forces transition to typed arrays
            assert(t[1] == big)
            assert(t[8] == big + 7)
            assert(t[9] == big + 8)
            return string.format("%.0f,%.0f,%.0f", t[1], t[8], t[9])
        `;
        expect(runLua(code)).toBe("10000000000,10000000007,10000000008");
    });

    test("Fuzzer: 2,000 randomized operations across 1..25 slots", () => {
        const code = `
            local t = {}
            local ref = {}
            local rng = 1234567

            local function pseudo_random(max)
                rng = (rng * 1103515245 + 12345) % 2147483648
                return (rng % max) + 1
            end

            for step = 1, 2000 do
                local op = pseudo_random(4)
                if op == 1 then
                    -- insert at end
                    local v = pseudo_random(1000)
                    table.insert(t, v)
                    table.insert(ref, v)
                elseif op == 2 and #ref > 0 then
                    -- remove at random position
                    local pos = pseudo_random(#ref)
                    local r1 = table.remove(t, pos)
                    local r2 = table.remove(ref, pos)
                    assert(r1 == r2, "mismatch on remove value")
                elseif op == 3 and #ref < 25 then
                    -- insert at random position
                    local pos = pseudo_random(#ref + 1)
                    local v = pseudo_random(1000)
                    table.insert(t, pos, v)
                    table.insert(ref, pos, v)
                elseif op == 4 and #ref > 0 then
                    -- modify existing element
                    local pos = pseudo_random(#ref)
                    local v = pseudo_random(1000)
                    t[pos] = v
                    ref[pos] = v
                end

                assert(#t == #ref, "length mismatch at step " .. step)
                if step % 200 == 0 then
                    for i = 1, #ref do
                        assert(t[i] == ref[i], "element mismatch at step " .. step .. ", idx " .. i)
                    end
                end
            end
            return "ok"
        `;
        expect(runLua(code)).toBe("ok");
    });
});
