"use strict";

const {
    LUA_MINSTACK,
    LUA_RIDX_GLOBALS,
    LUA_RIDX_MAINTHREAD,
    constant_types: {
        LUA_NUMTAGS,
        LUA_TNIL,
        LUA_TBOOLEAN,
        LUA_TNUMFLT,
        LUA_TNUMINT,
        LUA_TTABLE,
        LUA_TTHREAD
    },
    thread_status: {
        LUA_OK
    }
} = require('./defs.js');
const lobject              = require('./lobject.js');
const ldo                  = require('./ldo.js');
const lapi                 = require('./lapi.js');
const ltable               = require('./ltable.js');
const ltm                  = require('./ltm.js');

const EXTRA_STACK = 5;

const BASIC_STACK_SIZE = 2 * LUA_MINSTACK;

class StackSoA extends Array {
    static get [Symbol.species]() {
        return Array;
    }

    constructor(capacity = 2048) {
        super(capacity);
        this.capacity = capacity;
        const tagBytes = (capacity + 7) & ~7;
        const totalBytes = tagBytes + (capacity * 8);

        this.buffer = new ArrayBuffer(totalBytes);
        this.tagBytes = tagBytes;

        this.tags = new Uint8Array(this.buffer, 0, capacity);
        this.valsF64 = new Float64Array(this.buffer, tagBytes, capacity);
        this.valsI64 = new BigInt64Array(this.buffer, tagBytes, capacity);
        this.refs = new Array(capacity).fill(null);
    }

    setNumber(slot, val) {
        this.tags[slot] = LUA_TNUMFLT;
        this.valsF64[slot] = val;
        this.refs[slot] = null;
        let tv = this[slot];
        if (tv) {
            tv.type = LUA_TNUMFLT;
            tv.value = val;
        }
    }

    setInteger(slot, val) {
        this.tags[slot] = LUA_TNUMINT;
        const bVal = typeof val === "bigint" ? val : BigInt(val);
        this.valsI64[slot] = bVal;
        this.refs[slot] = null;
        let tv = this[slot];
        if (tv) {
            tv.type = LUA_TNUMINT;
            tv.value = bVal;
        }
    }

    setObject(slot, tag, obj) {
        this.tags[slot] = tag;
        this.valsF64[slot] = (tag === LUA_TBOOLEAN && obj) ? 1 : 0;
        this.refs[slot] = obj;
        let tv = this[slot];
        if (tv) {
            tv.type = tag;
            tv.value = (tag === LUA_TBOOLEAN) ? (obj ? true : false) : obj;
        }
    }

    setNil(slot) {
        this.tags[slot] = LUA_TNIL;
        this.valsF64[slot] = 0;
        this.refs[slot] = null;
        let tv = this[slot];
        if (tv) {
            tv.type = LUA_TNIL;
            tv.value = null;
        }
    }

    setBoolean(slot, b) {
        this.tags[slot] = LUA_TBOOLEAN;
        this.valsF64[slot] = b ? 1 : 0;
        this.refs[slot] = null;
        let tv = this[slot];
        if (tv) {
            tv.type = LUA_TBOOLEAN;
            tv.value = b ? true : false;
        }
    }

    getTValue(slot) {
        let tv = this[slot];
        const tag = this.tags[slot];
        const val = (tag === LUA_TNUMINT) ? this.valsI64[slot] :
            (tag === LUA_TNUMFLT) ? this.valsF64[slot] :
                (tag === LUA_TNIL ? null :
                    (tag === LUA_TBOOLEAN ? (this.valsF64[slot] !== 0) : this.refs[slot]));
        if (!tv) {
            tv = this[slot] = new lobject.TValue(tag, val);
        } else {
            tv.type = tag;
            tv.value = val;
        }
        return tv;
    }

    copy(dstSlot, srcSlot) {
        this.tags[dstSlot] = this.tags[srcSlot];
        this.valsF64[dstSlot] = this.valsF64[srcSlot];
        this.refs[dstSlot] = this.refs[srcSlot];
        let dst = this[dstSlot];
        if (dst) {
            const tag = this.tags[dstSlot];
            dst.type = tag;
            dst.value = (tag === LUA_TNUMINT) ? this.valsI64[dstSlot] :
                (tag === LUA_TNUMFLT) ? this.valsF64[dstSlot] :
                    (tag === LUA_TNIL ? null :
                        (tag === LUA_TBOOLEAN ? (this.valsF64[dstSlot] !== 0) : this.refs[dstSlot]));
        }
    }

    grow(newCapacity) {
        const newTagBytes = (newCapacity + 7) & ~7;
        const newTotalBytes = newTagBytes + (newCapacity * 8);

        const newBuffer = new ArrayBuffer(newTotalBytes);
        const newTags = new Uint8Array(newBuffer, 0, newCapacity);
        const newValsF64 = new Float64Array(newBuffer, newTagBytes, newCapacity);
        const newValsI64 = new BigInt64Array(newBuffer, newTagBytes, newCapacity);

        newTags.set(this.tags);
        newValsF64.set(this.valsF64);

        const oldCapacity = this.capacity;
        this.capacity = newCapacity;
        this.tagBytes = newTagBytes;
        this.buffer = newBuffer;
        this.tags = newTags;
        this.valsF64 = newValsF64;
        this.valsI64 = newValsI64;

        this.refs.length = newCapacity;
        for (let i = oldCapacity; i < newCapacity; i++) {
            this.refs[i] = null;
        }
    }

    syncFromTValue(slot) {
        let tv = this[slot];
        if (!tv) return;
        this.tags[slot] = tv.type;
        if (tv.type === LUA_TNUMINT) {
            this.valsI64[slot] = typeof tv.value === "bigint" ? tv.value : BigInt(tv.value);
            this.refs[slot] = null;
        } else if (tv.type === LUA_TNUMFLT) {
            this.valsF64[slot] = tv.value;
            this.refs[slot] = null;
        } else if (tv.type === LUA_TBOOLEAN) {
            this.valsF64[slot] = tv.value ? 1 : 0;
            this.refs[slot] = null;
        } else {
            this.valsF64[slot] = 0;
            this.refs[slot] = tv.value;
        }
    }

    syncRange(start, end) {
        for (let i = start; i < end; i++) {
            this.syncFromTValue(i);
        }
    }
}

class CallFrameStack {
    constructor(maxFrames = 256) {
        this.maxFrames = maxFrames;
        this.ci_buffer = new Int32Array(maxFrames * 8);
        this.ci_closures = new Array(maxFrames).fill(null);
        this.ptr = 0;
    }

    push(funcOff, base, top, savedpc, nresults, callstatus, closure) {
        if (this.ptr >= this.ci_buffer.length) {
            this.grow(this.ci_buffer.length * 2);
        }
        const idx = this.ptr;
        this.ci_buffer[idx]     = funcOff;
        this.ci_buffer[idx + 1] = base;
        this.ci_buffer[idx + 2] = top;
        this.ci_buffer[idx + 3] = savedpc;
        this.ci_buffer[idx + 4] = nresults;
        this.ci_buffer[idx + 5] = callstatus;
        this.ci_closures[idx >>> 3] = closure;

        this.ptr += 8;
        return idx;
    }

    pop() {
        this.ptr -= 8;
        this.ci_closures[this.ptr >>> 3] = null;
        return this.ptr;
    }

    grow(newCap) {
        const newBuf = new Int32Array(newCap);
        newBuf.set(this.ci_buffer);
        this.ci_buffer = newBuf;
        this.maxFrames = newCap >>> 3;
        this.ci_closures.length = this.maxFrames;
    }
}

class CallInfo {

    constructor() {
        this.func = null;
        this.funcOff = 0;
        this.top = 0;
        this.previous = null;
        this.next = null;
        this.cfs_ptr = 0;

        /* only for Lua functions */
        this.l_base = 0; /* base for this function */
        this.l_code = null; /* reference to this.func.p.code */
        this.l_savedpc = 0; /* offset into l_code */
        /* only for JS functions */
        this.c_k = null;  /* continuation in case of yields */
        this.c_old_errfunc = 0;
        this.c_ctx = null;  /* context info. in case of yields */

        this.nresults = 0;
        this.callstatus = 0;
    }

}

class lua_State {

    constructor(g) {
        this.id = g.id_counter++;

        this.base_ci = new CallInfo(); /* CallInfo for first level (C calling Lua) */
        let cur = this.base_ci;
        for (let i = 0; i < 32; i++) {
            let next = new CallInfo();
            cur.next = next;
            next.previous = cur;
            cur = next;
        }

        this.top = 0; /* first free slot in the stack (SMI) */
        this.stack_last = 0; /* last free slot in the stack (SMI) */
        this.oldpc = 0; /* last pc traced (SMI) */

        /* preinit_thread */
        this.l_G = g;
        this.stack = null;
        this.ci = null;
        this.errorJmp = null;
        this.nCcalls = 0;
        this.hook = null;
        this.hookmask = 0;
        this.basehookcount = 0;
        this.allowhook = 1;
        this.hookcount = 0;
        this.nny = 1;
        this.status = LUA_OK;
        this.errfunc = 0;
        this.cfs = new CallFrameStack(256);
    }

}

class global_State {

    constructor() {
        this.id_counter = 1; /* used to give objects unique ids */
        this.ids = new WeakMap();
        this.tvalue_pool = new lobject.TValuePool(1024);

        this.mainthread = null;
        this.l_registry = new lobject.TValue(LUA_TNIL, null);
        this.panic = null;
        this.atnativeerror = null;
        this.version = null;
        this.tmname = new Array(ltm.TMS.TM_N);
        this.mt = new Array(LUA_NUMTAGS);
        this._globalsTV = null;
    }

}

const luaE_extendCI = function(L) {
    let ci = new CallInfo();
    L.ci.next = ci;
    ci.previous = L.ci;
    ci.next = null;
    L.ci = ci;
    return ci;
};

const luaE_freeCI = function(L) {
    let ci = L.ci;
    ci.next = null;
};

const stack_init = function(L1, L) {
    L1.stack = new StackSoA(BASIC_STACK_SIZE);
    for (let i = 0; i < BASIC_STACK_SIZE; i++)
        L1.stack[i] = new lobject.TValue(LUA_TNIL, null);
    L1.top = 0;
    L1.stack_last = BASIC_STACK_SIZE - EXTRA_STACK;
    /* initialize first ci */
    let ci = L1.base_ci;
    ci.next = ci.previous = null;
    ci.callstatus = 0;
    ci.funcOff = L1.top;
    ci.func = L1.stack[L1.top];
    L1.top++;
    ci.top = L1.top + LUA_MINSTACK;
    L1.ci = ci;
};

const freestack = function(L) {
    L.ci = L.base_ci;
    luaE_freeCI(L);
    L.stack = null;
};

/*
** Create registry table and its predefined values
*/
const init_registry = function(L, g) {
    let registry = ltable.luaH_new(L);
    registry._l_G = g;
    g.l_registry.sethvalue(registry);
    let globalsTable = ltable.luaH_new(L);
    g._globalsTV = new lobject.TValue(LUA_TTABLE, globalsTable);
    ltable.luaH_setint(registry, LUA_RIDX_MAINTHREAD, new lobject.TValue(LUA_TTHREAD, L));
    ltable.luaH_setint(registry, LUA_RIDX_GLOBALS, g._globalsTV);
};

/*
** open parts of the state that may cause memory-allocation errors.
** ('g->version' !== NULL flags that the state was completely build)
*/
const f_luaopen = function(L) {
    let g = L.l_G;
    stack_init(L, L);
    init_registry(L, g);
    ltm.luaT_init(L);
    g.version = lapi.lua_version(null);
};

const lua_newthread = function(L) {
    let g = L.l_G;
    let L1 = new lua_State(g);
    L.stack[L.top] = new lobject.TValue(LUA_TTHREAD, L1);
    lapi.api_incr_top(L);
    L1.hookmask = L.hookmask;
    L1.basehookcount = L.basehookcount;
    L1.hook = L.hook;
    L1.hookcount = L1.basehookcount;
    stack_init(L1, L);
    return L1;
};

const luaE_freethread = function(L, L1) {
    freestack(L1);
};

const lua_newstate = function() {
    let g = new global_State();
    let L = new lua_State(g);
    g.mainthread = L;

    if (ldo.luaD_rawrunprotected(L, f_luaopen, null) !== LUA_OK) {
        L = null;
    }

    return L;
};

const close_state = function(L) {
    freestack(L);
};

const lua_close = function(L) {
    L = L.l_G.mainthread;  /* only the main thread can be closed */
    close_state(L);
};

module.exports.lua_State       = lua_State;
module.exports.CallInfo        = CallInfo;
module.exports.StackSoA        = StackSoA;
module.exports.CallFrameStack  = CallFrameStack;
module.exports.CIST_OAH        = (1<<0);  /* original value of 'allowhook' */
module.exports.CIST_LUA        = (1<<1);  /* call is running a Lua function */
module.exports.CIST_HOOKED     = (1<<2);  /* call is running a debug hook */
module.exports.CIST_FRESH      = (1<<3);  /* call is running on a fresh invocation of luaV_execute */
module.exports.CIST_YPCALL     = (1<<4);  /* call is a yieldable protected call */
module.exports.CIST_TAIL       = (1<<5);  /* call was tail called */
module.exports.CIST_HOOKYIELD  = (1<<6);  /* last hook called yielded */
module.exports.CIST_LEQ        = (1<<7);  /* using __lt for __le */
module.exports.CIST_FIN        = (1<<8);   /* call is running a finalizer */
module.exports.EXTRA_STACK     = EXTRA_STACK;
module.exports.lua_close       = lua_close;
module.exports.lua_newstate    = lua_newstate;
module.exports.lua_newthread   = lua_newthread;
module.exports.luaE_extendCI   = luaE_extendCI;
module.exports.luaE_freeCI     = luaE_freeCI;
module.exports.luaE_freethread = luaE_freethread;
