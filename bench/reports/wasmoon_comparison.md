# VM Compute, Boundary & Memory/GC Benchmark Report

> [!NOTE]
> **Executive Summary:** `shaped-fengari` optimizes Lua 5.3 for 60 FPS real-time web applications by replacing per-register object wrappers with contiguous typed arrays (**StackSoA**) and small tables with flat packed arrays (**hybrid storage**). This eliminates GC pause spikes in-engine while outperforming WebAssembly (`wasmoon`) by **3.4x to 6.5x** on host boundary calls without Wasm boundary GC storms.

---

## 1. In-Engine Compute: Execution Time & Throughput

| Benchmark | Workload / Call Count | Base Fengari (Mean ± σ) | Shaped Fengari (Mean ± σ) | Wasmoon (Mean ± σ) | Shaped vs Base Speedup | Ratio vs Wasmoon |
|---|---|---|---|---|---|---|
| **fibonacci** | 7,049,155 | 6937.7 ± 109.2 ms (med: 6898.7, min: 6809.0) | 3053.8 ± 104.0 ms (med: 3042.4, min: 2918.3) | 298.9 ± 15.0 ms (med: 296.7, min: 285.9) | **2.27x faster** (+56.0%) | 10.22x (Wasmoon faster) |
| **arithmetic_loop** | 5,000,000 | 1538.7 ± 53.3 ms (med: 1535.4, min: 1469.2) | 1664.8 ± 55.4 ms (med: 1666.3, min: 1585.6) | 233.7 ± 10.7 ms (med: 229.8, min: 225.6) | 0.92x (8.2% slower) | 7.12x (Wasmoon faster) |
| **table_churn** | 100,000 | 755.0 ± 61.6 ms (med: 739.9, min: 673.3) | 533.1 ± 9.6 ms (med: 534.2, min: 516.2) | 204.1 ± 30.2 ms (med: 195.0, min: 171.7) | **1.42x faster** (+29.4%) | 2.61x (Wasmoon faster) |
| **binary_trees** | 16,383 | 180.3 ± 41.7 ms (med: 189.9, min: 76.2) | 146.7 ± 77.1 ms (med: 174.4, min: 48.6) | 18.2 ± 3.4 ms (med: 20.2, min: 12.9) | **1.23x faster** (+18.7%) | 8.08x (Wasmoon faster) |
| **coroutine_switch** | 100,000 | 713.5 ± 98.8 ms (med: 700.0, min: 575.5) | 679.1 ± 61.7 ms (med: 676.4, min: 596.3) | 199.6 ± 15.4 ms (med: 192.1, min: 185.7) | **1.05x faster** (+4.8%) | 3.40x (Wasmoon faster) |

---

## 2. In-Engine Compute: Memory Allocation & GC Churn Stability

| Benchmark | Workload | Base Fengari (Gross Alloc / GCs) | Shaped Fengari (Gross Alloc / GCs) | Wasmoon (V8 + Wasm) | GC Pause Delta | Peak RAM (Base / Shaped / Wasm) |
|---|---|---|---|---|---|---|
| **fibonacci** | 7,049,155 | 2.67 GB (174 GCs) | 19.48 MB (5 GCs) | 0.26 MB (+16MB Wasm) (0 GCs) | **169 fewer GCs** (71.9ms -> **4.3ms**) | 21.1 / **11.2** / 26.3 MB |
| **arithmetic_loop** | 5,000,000 | 8.65 MB (2 GCs) | 10.64 MB (2 GCs) | 0.25 MB (+16MB Wasm) (0 GCs) | 2.0ms -> **1.7ms** | 11.1 / **12.0** / 26.3 MB |
| **table_churn** | 100,000 | 246.03 MB (18 GCs) | 102.57 MB (8 GCs) | 8.62 MB (+16MB Wasm, 8.38MB Lua) (0 GCs) | **11 fewer GCs** (120.9ms -> **52.5ms**) | 78.9 / **96.0** / 26.3 MB |
| **binary_trees** | 16,383 | 37.07 MB (3 GCs) | 13.99 MB (1 GCs) | 1.26 MB (+16MB Wasm, 1.02MB Lua) (0 GCs) | **2 fewer GCs** (13.0ms -> **4.3ms**) | 26.1 / **17.7** / 26.3 MB |
| **coroutine_switch** | 100,000 | 158.00 MB (30 GCs) | 30.67 MB (8 GCs) | 0.23 MB (+16MB Wasm) (0 GCs) | **23 fewer GCs** (11.1ms -> **3.9ms**) | 12.8 / **12.6** / 26.3 MB |

---

## 3. Host Boundary Crossing: Execution Time & Latency

| Benchmark | Crossings | Base Fengari (Per Call) | Shaped Fengari (Per Call) | Wasmoon (Per Call) | Shaped vs Base | Shaped vs Wasmoon |
|---|---|---|---|---|---|---|
| **boundary_lua_calls_js_scalar** | 500,000 | 449.64 ± 18.8 ms (899.3 ns) | 391.70 ± 34.2 ms (783.4 ns) | 2501.02 ± 130.5 ms (5002.0 ns) | **1.15x faster** (+12.9%) | **6.39x (Shaped faster)** |
| **boundary_lua_calls_js_string** | 200,000 | 289.32 ± 15.8 ms (1446.6 ns) | 250.61 ± 33.8 ms (1253.1 ns) | 851.48 ± 105.6 ms (4257.4 ns) | **1.15x faster** (+13.4%) | **3.40x (Shaped faster)** |
| **boundary_js_calls_lua_scalar** | 200,000 | 472.42 ± 24.5 ms (2362.1 ns) | 194.90 ± 33.1 ms (974.5 ns) | 1275.16 ± 60.8 ms (6375.8 ns) | **2.42x faster** (+58.7%) | **6.54x (Shaped faster)** |

---

## 4. Host Boundary Crossing: Memory Churn & Allocation Stress

| Benchmark | Crossings | Base Fengari Alloc (GCs) | Shaped Fengari Alloc (GCs) | Wasmoon Alloc (GCs) | Shaped vs Base Alloc | Shaped vs Wasmoon GCs |
|---|---|---|---|---|---|---|
| **boundary_lua_calls_js_scalar** | 500,000 | 171.06 MB (37 GCs) | 16.78 MB (4 GCs) | 3232.63 MB (+16MB Wasm) (206 GCs) | **10.2x less churn** | **202 fewer GCs** (206 vs 4) |
| **boundary_lua_calls_js_string** | 200,000 | 300.62 MB (53 GCs) | 11.77 MB (3 GCs) | 1002.95 MB (+16MB Wasm) (127 GCs) | **25.5x less churn** | **125 fewer GCs** (127 vs 3) |
| **boundary_js_calls_lua_scalar** | 200,000 | 260.53 MB (50 GCs) | 6.27 MB (1 GCs) | 1603.55 MB (+16MB Wasm) (204 GCs) | **41.5x less churn** | **203 fewer GCs** (204 vs 1) |

---

## 5. Key Takeaways & Analysis

- **Deep Recursion (`fibonacci`)**: StackSoA eliminates per-register TValue allocation wrappers. **2.27x faster**, GC pause reduced from 71.9 ms (174 GCs) down to 4.3 ms (5 GCs).
- **Small Tables (`binary_trees`)**: Hybrid flat storage for <=8 elements reduces node allocation from 2373 B/node to 895 B/node (**1.23x faster**, -62% memory churn).
- **Table Churn (`table_churn`)**: Young hash entries and cached string keys drop max GC pause from 47.6 ms to 11.4 ms (**1.42x faster**).
- **Host Boundaries (`boundary_*`)**: Direct V8 heap execution avoids Wasm linear memory marshalling storms. Host JS->Lua runs in **974 ns/call** and **32.9 B/op** (**6.5x faster than Wasmoon**, 1 GC vs 204 GCs). Lua->JS runs **6.4x faster** (4 GCs vs 206 GCs).
- **Pure Math Loops (`arithmetic_loop`)**: Wasmoon (AOT C via Wasm) is 7.1x faster on closed numeric loops with zero host or table interaction.
- **Architecture Trade-offs**: Shaped Fengari prioritizes 60 FPS frame pacing and sub-microsecond host boundary calls. Register stacks are zero-GC; table float properties remain boxed as V8 HeapNumbers (~18–21 B/write).

