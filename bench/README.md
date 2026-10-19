# Fengari Performance Benchmark Suite

This directory contains the canonical benchmarking harness, statistical test data, and comparative reports for evaluating `shaped-fengari` runtime performance against upstream baseline revisions (**Base Fengari** v0.1.5) and WebAssembly runtimes (**`wasmoon`** / Lua 5.4 in Wasm).

The harness captures both **Execution Time (latency/throughput)** and **Memory Allocation Churn & GC Pause Stability**, highlighting the primary design goal of `shaped-fengari`: eliminating nursery garbage collection churn to preserve consistent 60 FPS frame pacing.

---

## 1. Directory Structure

```
bench/
├── README.md               # This documentation and index
├── benchmarks.js           # Canonical benchmark definitions (single source of truth)
├── run.js                  # Main unified benchmark CLI harness (tracks time, memory, & GC)
├── run_benchmarks.js       # Forwarding entrypoint alias to run.js
├── data/                   # Raw JSON benchmark records
│   └── latest_unified.json # Latest 10-iteration compute, boundary, memory & GC results
└── reports/                # Markdown comparison reports
    └── wasmoon_comparison.md# Latest empirical report across Base Fengari, Shaped Fengari, and Wasmoon
```

---

## 2. Canonical Benchmarks ([`benchmarks.js`](./benchmarks.js))

All benchmark runners and engines execute the exact same canonical Lua scripts:

### A. Pure VM Compute Benchmarks
- **`fibonacci`**: Recursive `fib(32)` making **$7,049,155$ recursive calls** ($2 \times \text{fib}(33) - 1$). Tests call frame creation, register window shifting, stack unwinding, branching, and arithmetic. Stresses per-register object wrapper churn vs. `StackSoA` typed arrays.
- **`arithmetic_loop`**: Tight numeric `while` loop with $5,000,000$ iterations computing `(sum + i * 3 - 7) % 1000000`. Tests raw register math, modulo, and branch conditions.
- **`table_churn`**: Inserts and reads $100,000$ string keys (`k_ .. i`). Tests string hashing (`luaS_hash`), intern table indexing, and GC memory allocation.
- **`binary_trees`**: Creates and traverses a full binary tree of depth 13 ($16,383$ nodes). Stresses table allocation churn and GC nursery sweeps.
- **`coroutine_switch`**: Coroutine ping-pong with $100,000$ `yield`/`resume` cycles. Tests thread stack preservation and context switching.

### B. Host Boundary Crossing Microbenchmarks
- **`boundary_lua_calls_js_scalar`**: Lua calls host JavaScript function `host_add(a, b)` $500,000$ times. Tests direct function invocation across the runtime boundary.
- **`boundary_lua_calls_js_string`**: Lua calls host JavaScript function with string arguments `host_len(str)` $200,000$ times. Tests string interop and linear memory pointer marshalling.
- **`boundary_js_calls_lua_scalar`**: Host JavaScript invokes Lua function `lua_add(a, b)` $200,000$ times via C-style trampoline / API.

---

## 3. Tracked Performance & Stability Metrics

For every benchmark iteration, the harness records:

| Metric | Source / Method | Description |
|---|---|---|
| **Execution Time** | `performance.now()` | Latency in milliseconds; mean, median, min, max, standard deviation ($\sigma$). |
| **Cost per Operation** | $(T_{\text{mean}} \times 10^6) / N_{\text{calls}}$ | Nanoseconds spent per recursive call or loop operation. |
| **Heap Memory Allocated** | `v8.getHeapStatistics().total_allocated_bytes` | Total cumulative heap bytes allocated during the execution (before any GC sweeps). |
| **Bytes / Op** | $\text{Allocated Bytes} / N_{\text{calls}}$ | Average memory churn generated per operation. |
| **GC Cycle Count** | `PerformanceObserver` (`entryTypes: ['gc']`) | Number of V8 garbage collections (nursery scavenges and mark-sweeps) triggered. |
| **GC Pause Duration** | `PerformanceObserver` entry duration | Cumulative time (ms) spent in V8 stop-the-world GC pauses during the run. |
| **Max GC Pause** | $\max(\text{pause})$ | Worst-case single GC pause duration (the critical driver of frame-drops in 60 FPS / 16.6ms loops). |

---

## 4. Usage & CLI Flags

Run the unified benchmark suite using Node with explicit GC exposed:

```bash
# Run full suite (compute + boundary) with 10 iterations across all engines:
node --expose-gc bench/run.js

# Or via npm script:
npm run bench
```

### CLI Options:

| Flag | Values | Default | Description |
|---|---|---|---|
| `--engine` | `all`, `base-fengari`, `shaped-fengari`, `wasmoon` | `all` | Select which runtime engines to execute (comma-separated or single; aliases `base`, `shaped`, `fengari` supported) |
| `-n` | Integer (e.g. `5`, `10`, `20`) | `10` | Number of timed iterations per benchmark |
| `--warmups` | Integer (e.g. `1`, `2`) | `2` | Number of untimed warmup runs before sampling |
| `--category` | `all`, `compute`, `boundary` | `all` | Filter to run only compute or boundary tests |
| `--out` | String (e.g. `phase3_run`) | `latest_unified` | Output prefix for `bench/data/<out>.json` and `bench/reports/<out>.md` |

### Examples:
```bash
# Run comparison between Base Fengari and Shaped Fengari:
node --expose-gc bench/run.js --engine base-fengari,shaped-fengari

# Run only boundary microbenchmarks with 15 iterations:
node --expose-gc bench/run.js --category boundary -n 15

# Run only pure VM compute on Shaped Fengari:
node --expose-gc bench/run.js --engine shaped-fengari --category compute

# Save custom comparison output:
node --expose-gc bench/run.js --out custom_experiment
```

---

## 5. Key Architectural Insights: Why Memory & GC Stability is the Core Win

- **The Real-Time Frame Pacing Problem**:
  In a 60 FPS game (16.6ms per frame), intermittent nursery GC sweeps cause micro-stutter and input lag. In standard Lua-in-JS interpreters like upstream Fengari, each stack register write creates a temporary `{ type, value }` JavaScript object wrapper. Across millions of operations, this floods the V8 nursery, triggering continuous stop-the-world GC cycles.
- **`StackSoA` Typed Array Elimination**:
  `shaped-fengari` replaces object wrappers with parallel typed arrays (`Uint8Array` type tags, `Float64Array` numeric values). In recursive call-heavy workloads (`fibonacci`), this cuts heap allocation by **>99.6%** (from **2,732 MB down to 8.8 MB**), completely eliminating nursery GC pauses (reducing GC cycles from **~585 down to 0**).
- **Zero-Copy Host Interoperability (vs WebAssembly)**:
  Crossing the boundary between WebAssembly (`wasmoon`) and JavaScript requires copying and marshalling arguments across linear memory, generating **gigabytes of temporary wrapper objects** (over 3.4 GB allocated in Wasmoon during scalar boundary calls). `shaped-fengari` executes natively within V8's heap, requiring zero marshalling and keeping boundary allocations negligible.
