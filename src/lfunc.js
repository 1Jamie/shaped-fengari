"use strict";

const {
    constant_types: {
        LUA_TNIL,
        LUA_TBOOLEAN,
        LUA_TNUMFLT,
        LUA_TNUMINT
    }
} = require('./defs.js');
const lobject = require('./lobject.js');

const readSlot = function(stack, slot) {
    const tag = stack.tags[slot];
    if (tag === LUA_TNUMINT) return stack.valsI64[slot];
    if (tag === LUA_TNUMFLT) return stack.valsF64[slot];
    if (tag === LUA_TNIL) return null;
    if (tag === LUA_TBOOLEAN) return stack.valsF64[slot] !== 0;
    return stack.refs[slot];
};

const copySlot = function(dst, dstSlot, src, srcSlot) {
    const d = dst.rawStack || dst;
    const s = src.rawStack || src;
    d.tags[dstSlot] = s.tags[srcSlot];
    d.valsF64[dstSlot] = s.valsF64[srcSlot];
    d.refs[dstSlot] = s.refs[srcSlot];
    if (d.dropView) d.dropView(dstSlot);
};

const writePayload = function(stack, slot, v) {
    const tag = stack.tags[slot];
    if (tag === LUA_TNUMINT) {
        stack.valsI64[slot] = typeof v === "bigint" ? v : BigInt(v);
        stack.refs[slot] = null;
    } else if (tag === LUA_TNUMFLT) {
        stack.valsF64[slot] = v;
        stack.refs[slot] = null;
    } else if (tag === LUA_TBOOLEAN) {
        stack.valsF64[slot] = v ? 1 : 0;
        stack.refs[slot] = null;
    } else if (tag === LUA_TNIL) {
        stack.valsF64[slot] = 0;
        stack.refs[slot] = null;
    } else {
        stack.valsF64[slot] = 0;
        stack.refs[slot] = v;
    }
    if (stack.dropView) stack.dropView(slot);
};

class UpVal extends lobject.TValue {
    constructor() {
        super(LUA_TNIL, null);
        delete this.type;
        delete this.value;
        this._type = LUA_TNIL;
        this._value = null;
        this.open = false;
        this.ownerStack = null;
        this.ownerSlot = -1;
    }

    get type() {
        return this.open ? this.ownerStack.tags[this.ownerSlot] : this._type;
    }

    set type(t) {
        if (this.open) this.ownerStack.tags[this.ownerSlot] = t;
        else this._type = t;
    }

    get value() {
        return this.open ? readSlot(this.ownerStack, this.ownerSlot) : this._value;
    }

    set value(v) {
        if (this.open) writePayload(this.ownerStack, this.ownerSlot, v);
        else this._value = v;
    }

    setfrom(tv) {
        const tag = tv.type;
        const val = tv.value;
        if (this.open) {
            this.ownerStack.tags[this.ownerSlot] = tag;
            writePayload(this.ownerStack, this.ownerSlot, val);
        } else {
            this._type = tag;
            this._value = val;
        }
    }

    close() {
        if (!this.open) return;
        this._type = this.ownerStack.tags[this.ownerSlot];
        this._value = readSlot(this.ownerStack, this.ownerSlot);
        this.open = false;
        this.ownerStack = null;
        this.ownerSlot = -1;
    }

    loadTo(stack, slot) {
        if (this.open) {
            copySlot(stack, slot, this.ownerStack, this.ownerSlot);
            return;
        }
        const tag = this._type;
        if (tag === LUA_TNUMINT) stack.setInteger(slot, this._value);
        else if (tag === LUA_TNUMFLT) stack.setNumber(slot, this._value);
        else if (tag === LUA_TBOOLEAN) stack.setBoolean(slot, this._value);
        else if (tag === LUA_TNIL) stack.setNil(slot);
        else stack.setObject(slot, tag, this._value);
    }

    storeFrom(stack, slot) {
        if (this.open) {
            copySlot(this.ownerStack, this.ownerSlot, stack, slot);
            return;
        }
        this._type = stack.tags[slot];
        this._value = readSlot(stack, slot);
    }
}

class Proto {
    constructor(L) {
        this.id = L.l_G.id_counter++;
        this.k = [];              // constants used by the function
        this.p = [];              // functions defined inside the function
        this.code = [];           // opcodes
        this.cache = null;        // last-created closure with this prototype
        this.lineinfo = [];       // map from opcodes to source lines (debug information)
        this.upvalues = [];       // upvalue information
        this.numparams = 0;       // number of fixed parameters
        this.is_vararg = false;
        this.maxstacksize = 0;    // number of registers needed by this function
        this.locvars = [];        // information about local variables (debug information)
        this.linedefined = 0;     // debug information
        this.lastlinedefined = 0; // debug information
        this.source = null;       // used for debug information
    }
}

const luaF_newLclosure = function(L, n) {
    return new lobject.LClosure(L, n);
};


const luaF_findupval = function(L, level) {
    let open = L.openUpvals;
    let uv = open.get(level);
    if (uv) return uv;
    uv = new UpVal();
    uv.open = true;
    uv.ownerStack = L.stack;
    uv.ownerSlot = level;
    open.set(level, uv);
    return uv;
};

const luaF_close = function(L, level) {
    let open = L.openUpvals;
    if (!open || open.size === 0) return;
    for (const slot of Array.from(open.keys())) {
        if (slot >= level) {
            open.get(slot).close();
            open.delete(slot);
        }
    }
};

/*
** fill a closure with new upvalues
*/
const luaF_initupvals = function(L, cl) {
    for (let i = 0; i < cl.nupvalues; i++)
        cl.upvals[i] = new UpVal();
};

/* Typed views of prototype constants. Built when the proto is finished. */
const luaF_finishproto = function(p) {
    const k = p.k;
    const kLen = k.length;
    const kTags = new Uint8Array(kLen);
    const kVals = new Float64Array(kLen);
    const kValsI64 = new BigInt64Array(kLen);
    for (let ki = 0; ki < kLen; ki++) {
        const item = k[ki];
        kTags[ki] = item.type;
        if (item.type === LUA_TNUMINT) {
            const bi = typeof item.value === "bigint" ? item.value : BigInt(item.value);
            kValsI64[ki] = bi;
            kVals[ki] = Number(bi);
        } else if (typeof item.value === "number") {
            kVals[ki] = item.value;
        } else if (typeof item.value === "boolean") {
            kVals[ki] = item.value ? 1 : 0;
        }
    }
    p.kTags = kTags;
    p.kVals = kVals;
    p.kValsI64 = kValsI64;
};

/*
** Look for n-th local variable at line 'line' in function 'func'.
** Returns null if not found.
*/
const luaF_getlocalname = function(f, local_number, pc) {
    for (let i = 0; i < f.locvars.length && f.locvars[i].startpc <= pc; i++) {
        if (pc < f.locvars[i].endpc) {  /* is variable active? */
            local_number--;
            if (local_number === 0)
                return f.locvars[i].varname.getstr();
        }
    }
    return null;  /* not found */
};

module.exports.MAXUPVAL          = 255;
module.exports.Proto             = Proto;
module.exports.UpVal             = UpVal;
module.exports.luaF_findupval    = luaF_findupval;
module.exports.luaF_close        = luaF_close;
module.exports.luaF_finishproto  = luaF_finishproto;
module.exports.luaF_getlocalname = luaF_getlocalname;
module.exports.luaF_initupvals   = luaF_initupvals;
module.exports.luaF_newLclosure  = luaF_newLclosure;
