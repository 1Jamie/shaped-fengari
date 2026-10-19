"use strict";

/**
 * CANONICAL BENCHMARK DEFINITIONS
 * This file is the single source of truth for all benchmark code.
 * All runners (Fengari baseline, Phase 1, Phase 2, Wasmoon, future phases)
 * MUST import and execute these exact definitions.
 */

const COMPUTE_BENCHMARKS = [
    {
        name: "fibonacci",
        category: "compute",
        description: "Recursive Fibonacci(32) - 7,049,155 recursive calls, call frames, register windows",
        callCount: 7049155,
        lua: `
local function fib(n)
    if n < 2 then return n end
    return fib(n - 1) + fib(n - 2)
end
return fib(32)
`
    },
    {
        name: "arithmetic_loop",
        category: "compute",
        description: "Tight numeric while loop (5,000,000 iterations) with arithmetic and modulo",
        callCount: 5000000,
        lua: `
local sum = 0
local i = 0
while i < 5000000 do
    sum = (sum + i * 3 - 7) % 1000000
    i = i + 1
end
return sum
`
    },
    {
        name: "table_churn",
        category: "compute",
        description: "Insert & read 100,000 string keys ('k_' .. i) - string hashing & table access",
        callCount: 100000,
        lua: `
local t = {}
for i = 1, 100000 do
    t["k_" .. i] = i
end
local sum = 0
for i = 1, 100000 do
    sum = sum + t["k_" .. i]
end
return sum
`
    },
    {
        name: "binary_trees",
        category: "compute",
        description: "Binary tree creation & traversal (depth 13) - table allocations & GC pressure",
        callCount: 16383,
        lua: `
local function make_tree(depth)
    if depth == 0 then return { nil, nil } end
    return { make_tree(depth - 1), make_tree(depth - 1) }
end
local function check_tree(node)
    if not node[1] then return 1 end
    return 1 + check_tree(node[1]) + check_tree(node[2])
end
local tree = make_tree(13)
return check_tree(tree)
`
    },
    {
        name: "coroutine_switch",
        category: "compute",
        description: "Coroutine ping-pong (100,000 yields/resumes) - thread stack switching",
        callCount: 100000,
        lua: `
local co = coroutine.create(function()
    for i = 1, 100000 do
        coroutine.yield(i)
    end
end)
local sum = 0
while coroutine.status(co) ~= "dead" do
    local ok, val = coroutine.resume(co)
    if ok and val then sum = sum + val end
end
return sum
`
    }
];

const BOUNDARY_BENCHMARKS = [
    {
        name: "boundary_lua_calls_js_scalar",
        category: "boundary",
        description: "Lua calling host JS function: host_add(a, b) (500,000 boundary crossings)",
        callCount: 500000,
        iterationsCount: 500000,
        setupLua: `
local sum = 0
for i = 1, 500000 do
    sum = host_add(sum, 1)
end
return sum
`
    },
    {
        name: "boundary_lua_calls_js_string",
        category: "boundary",
        description: "Lua calling host JS function with string arg: host_len(str) (200,000 crossings)",
        callCount: 200000,
        iterationsCount: 200000,
        setupLua: `
local sum = 0
local str = "sample_entity_name_identifier_for_testing"
for i = 1, 200000 do
    sum = sum + host_len(str)
end
return sum
`
    },
    {
        name: "boundary_js_calls_lua_scalar",
        category: "boundary",
        description: "Host JS calling Lua function: lua_add(a, b) (200,000 boundary crossings)",
        callCount: 200000,
        iterationsCount: 200000,
        initLua: `
function lua_add(a, b)
    return a + b
end
`
    }
];

module.exports = {
    COMPUTE_BENCHMARKS,
    BOUNDARY_BENCHMARKS
};
