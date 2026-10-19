#!/usr/bin/env node
"use strict";

const v8 = require("v8");
const { performance } = require("perf_hooks");

let baseFengari = null;
try {
    baseFengari = require("base-fengari");
} catch (e) {
    try {
        baseFengari = require("fengari-base");
    } catch (e2) {}
}

const shapedFengari = require("../src/fengari.js");

let wasmoon = null;
try {
    wasmoon = require("wasmoon");
} catch (e) {}

function measureGrossAlloc(fn) {
    if (global.gc) global.gc();
    const prof = new v8.GCProfiler();
    prof.start();
    const beforeMem = process.memoryUsage();
    const t0 = performance.now();

    fn();

    const durationMs = performance.now() - t0;
    const afterMem = process.memoryUsage();
    const res = prof.stop();

    let gross = 0;
    let base = beforeMem.heapUsed;
    let gcDuration = 0;
    let maxPause = 0;

    for (const s of (res.statistics || [])) {
        const b = s.beforeGC.heapStatistics.usedHeapSize;
        const a = s.afterGC.heapStatistics.usedHeapSize;
        if (b > base) gross += (b - base);
        base = a;
        const costMs = s.cost / 1000;
        gcDuration += costMs;
        if (costMs > maxPause) maxPause = costMs;
    }
    if (afterMem.heapUsed > base) gross += (afterMem.heapUsed - base);

    return {
        durationMs,
        grossBytes: gross,
        grossMB: gross / (1024 * 1024),
        gcCount: res.statistics.length,
        gcDurationMs: gcDuration,
        maxPauseMs: maxPause
    };
}

function runLuaSuite(engine, code) {
    const L = engine.lauxlib.luaL_newstate();
    engine.lualib.luaL_openlibs(L);
    engine.lauxlib.luaL_dostring(L, engine.to_luastring(code));
    engine.lua.lua_close(L);
}

async function run() {
    console.log("================================================================================");
    console.log("FLOAT BOXING & GAME VEC2/VEC3 BENCHMARK");
    console.log("Tests whether small-table packed JS arrays box doubles into HeapNumbers on write");
    console.log("================================================================================\n");

    const workloads = [
        {
            name: "Register Stack (Local Floats - No Tables)",
            desc: "1,000,000 iterations updating local float variables on stack",
            code: `
                local x, y = 1.5, 2.5
                for i = 1, 1000000 do
                    x = x + 0.1
                    y = y + 0.2
                end
                return x + y
            `,
            writes: 2000000
        },
        {
            name: "Small Array vec2: {1.5, 2.5} (asize <= 8)",
            desc: "1,000,000 iterations mutating array entries vec[1], vec[2]",
            code: `
                local vec = { 1.5, 2.5 }
                for i = 1, 1000000 do
                    vec[1] = vec[1] + 0.1
                    vec[2] = vec[2] + 0.2
                end
                return vec[1] + vec[2]
            `,
            writes: 2000000
        },
        {
            name: "Record Table vec2: {x=1.5, y=2.5}",
            desc: "1,000,000 iterations mutating record fields vec.x, vec.y",
            code: `
                local vec = { x = 1.5, y = 2.5 }
                for i = 1, 1000000 do
                    vec.x = vec.x + 0.1
                    vec.y = vec.y + 0.2
                end
                return vec.x + vec.y
            `,
            writes: 2000000
        },
        {
            name: "Small Array vec3: {1.5, 2.5, 3.5} (asize <= 8)",
            desc: "1,000,000 iterations mutating array entries vec[1], vec[2], vec[3]",
            code: `
                local vec = { 1.5, 2.5, 3.5 }
                for i = 1, 1000000 do
                    vec[1] = vec[1] + 0.1
                    vec[2] = vec[2] + 0.2
                    vec[3] = vec[3] + 0.3
                end
                return vec[1] + vec[2] + vec[3]
            `,
            writes: 3000000
        },
        {
            name: "Simulated 60 FPS Game Frame Loop (1,000 entities * 60 frames)",
            desc: "1,000 entity vec2 tables updated every frame for 60 frames (1 second of game time)",
            code: `
                local entities = {}
                for i = 1, 1000 do
                    entities[i] = { x = 1.5, y = 2.5, vx = 0.1, vy = 0.2 }
                end
                for frame = 1, 60 do
                    for i = 1, 1000 do
                        local e = entities[i]
                        e.x = e.x + e.vx
                        e.y = e.y + e.vy
                    end
                end
                return entities[1].x
            `,
            writes: 120000
        }
    ];

    for (const w of workloads) {
        console.log(`### Workload: ${w.name}`);
        console.log(`    ${w.desc} (${w.writes.toLocaleString()} float writes)`);

        // Base Fengari
        let baseRes = null;
        if (baseFengari) {
            baseRes = measureGrossAlloc(() => runLuaSuite(baseFengari, w.code));
            const bBpw = (baseRes.grossBytes / w.writes).toFixed(1);
            console.log(`    Base Fengari:   ${baseRes.durationMs.toFixed(1).padStart(7)} ms | Gross: ${baseRes.grossMB.toFixed(2).padStart(6)} MB (${bBpw.padStart(4)} B/write) | GCs: ${String(baseRes.gcCount).padStart(2)} (pause: ${baseRes.gcDurationMs.toFixed(1)} ms, max: ${baseRes.maxPauseMs.toFixed(1)} ms)`);
        }

        // Shaped Fengari
        const shapedRes = measureGrossAlloc(() => runLuaSuite(shapedFengari, w.code));
        const sBpw = (shapedRes.grossBytes / w.writes).toFixed(1);
        console.log(`    Shaped Fengari: ${shapedRes.durationMs.toFixed(1).padStart(7)} ms | Gross: ${shapedRes.grossMB.toFixed(2).padStart(6)} MB (${sBpw.padStart(4)} B/write) | GCs: ${String(shapedRes.gcCount).padStart(2)} (pause: ${shapedRes.gcDurationMs.toFixed(1)} ms, max: ${shapedRes.maxPauseMs.toFixed(1)} ms)`);

        if (baseRes) {
            const speedup = (baseRes.durationMs / shapedRes.durationMs).toFixed(2);
            console.log(`    -> Shaped vs Base: ${speedup}x speedup | GC Pauses: ${baseRes.gcCount} -> ${shapedRes.gcCount}`);
        }
        console.log();
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
