"use strict";

const {
    constant_types: {
        LUA_TBOOLEAN,
        LUA_TCCL,
        LUA_TLCF,
        LUA_TLCL,
        LUA_TLIGHTUSERDATA,
        LUA_TLNGSTR,
        LUA_TNIL,
        LUA_TNUMFLT,
        LUA_TNUMINT,
        LUA_TSHRSTR,
        LUA_TTABLE,
        LUA_TTHREAD,
        LUA_TUSERDATA
    },
    LUA_RIDX_GLOBALS,
    to_luastring
} = require('./defs.js');
const {
    LUA_MAXINTEGER
} = require('./luaconf.js');
const { lua_assert } = require('./llimits.js');
const ldebug  = require('./ldebug.js');
const lobject = require('./lobject.js');
const {
    luaS_hashlongstr,
    TString
} = require('./lstring.js');
const lstate  = require('./lstate.js');

/* used to prevent conflicts with lightuserdata keys */
let lightuserdata_hashes = new WeakMap();
const get_lightuserdata_hash = function(v) {
    let hash = lightuserdata_hashes.get(v);
    if (!hash) {
        /* Hash should be something unique that is a valid WeakMap key
           so that it ends up in dead_weak when removed from a table */
        hash = {};
        lightuserdata_hashes.set(v, hash);
    }
    return hash;
};

const table_hash = function(L, key) {
    switch(key.type) {
        case LUA_TNIL:
            return ldebug.luaG_runerror(L, to_luastring("table index is nil", true));
        case LUA_TNUMFLT:
            if (isNaN(key.value))
                return ldebug.luaG_runerror(L, to_luastring("table index is NaN", true));
            /* fall through */
        case LUA_TNUMINT: /* takes advantage of floats and integers being same in JS */
        case LUA_TBOOLEAN:
        case LUA_TTABLE:
        case LUA_TLCL:
        case LUA_TLCF:
        case LUA_TCCL:
        case LUA_TUSERDATA:
        case LUA_TTHREAD:
            return key.value;
        case LUA_TSHRSTR:
        case LUA_TLNGSTR:
            return luaS_hashlongstr(key.tsvalue());
        case LUA_TLIGHTUSERDATA: {
            let v = key.value;
            switch(typeof v) {
                case "string":
                    /* possible conflict with LUA_TSTRING.
                       prefix this string with "*" so they don't clash */
                    return "*" + v;
                case "number":
                    /* possible conflict with LUA_TNUMBER.
                       turn into string and prefix with "#" to avoid clash with other strings */
                    return "#" + v;
                case "boolean":
                    /* possible conflict with LUA_TBOOLEAN. use strings ?true and ?false instead */
                    return v?"?true":"?false";
                case "function":
                    /* possible conflict with LUA_TLCF.
                       indirect via a weakmap */
                    return get_lightuserdata_hash(v);
                case "object":
                    /* v could be a lua_State, CClosure, LClosure, Table or Userdata from this state as returned by lua_topointer */
                    if ((v instanceof lstate.lua_State && v.l_G === L.l_G) ||
                        v instanceof Table ||
                        v instanceof lobject.Udata ||
                        v instanceof lobject.LClosure ||
                        v instanceof lobject.CClosure) {
                        /* indirect via a weakmap */
                        return get_lightuserdata_hash(v);
                    }
                    /* fall through */
                default:
                    return v;
            }
        }
        default:
            throw new Error("unknown key type: " + key.type);
    }
};

class TableStrongView {
    constructor(table) {
        this._table = table;
    }
    get(k) {
        const t = this._table;
        if (t && t.asize > 0 && typeof k === 'number' && (k | 0) === k) {
            const idx = (k - 1) >>> 0;
            if (idx < t.asize) {
                let tag, val;
                if (t.arr) {
                    tag = t.arr[idx * 2];
                    val = t.arr[idx * 2 + 1];
                } else if (t.arrTags) {
                    tag = t.arrTags[idx];
                    val = t.arrRefs[idx] !== null ? t.arrRefs[idx] : (tag === LUA_TBOOLEAN ? (t.arrValsF64[idx] !== 0) : t.arrValsF64[idx]);
                }
                if (tag !== undefined && tag !== LUA_TNIL) {
                    return {
                        key: new lobject.TValue(LUA_TNUMINT, k),
                        value: new lobject.TValue(tag, (tag === LUA_TBOOLEAN) ? (val ? true : false) : val)
                    };
                }
            }
        }
        return t._strong ? t._strong.get(k) : undefined;
    }
    has(k) {
        const t = this._table;
        if (t && t.asize > 0 && typeof k === 'number' && (k | 0) === k) {
            const idx = (k - 1) >>> 0;
            if (idx < t.asize) {
                if (t.arr) return t.arr[idx * 2] !== LUA_TNIL;
                if (t.arrTags) return t.arrTags[idx] !== LUA_TNIL;
            }
        }
        return t._strong ? t._strong.has(k) : false;
    }
    get size() {
        let count = this._table._strong ? this._table._strong.size : 0;
        const t = this._table;
        if (t && t.asize > 0) {
            for (let i = 0; i < t.asize; i++) {
                if (t.arr ? t.arr[i * 2] !== LUA_TNIL : (t.arrTags && t.arrTags[i] !== LUA_TNIL)) count++;
            }
        }
        return count;
    }
    *entries() {
        const t = this._table;
        if (t && t.asize > 0) {
            for (let i = t.asize - 1; i >= 0; i--) {
                const tag = t.arr ? t.arr[i * 2] : (t.arrTags ? t.arrTags[i] : LUA_TNIL);
                if (tag !== LUA_TNIL && tag !== undefined) {
                    const k = i + 1;
                    const val = t.arr ? t.arr[i * 2 + 1] : (t.arrRefs[i] !== null ? t.arrRefs[i] : (tag === LUA_TBOOLEAN ? (t.arrValsF64[i] !== 0) : t.arrValsF64[i]));
                    yield [k, {
                        key: new lobject.TValue(LUA_TNUMINT, k),
                        value: new lobject.TValue(tag, (tag === LUA_TBOOLEAN) ? (val ? true : false) : val)
                    }];
                }
            }
        }
        if (t._strong) {
            yield* t._strong.entries();
        }
    }
    [Symbol.iterator]() {
        return this.entries();
    }
    forEach(callback, thisArg) {
        for (const [k, v] of this.entries()) {
            callback.call(thisArg, v, k, this);
        }
    }
}

class Table {
    constructor(L, asize = 0) {
        this.id = L ? L.l_G.id_counter++ : 0;
        this.asize = asize;
        if (asize > 8) {
            const tagBytes = (asize + 7) & ~7;
            const buffer = new ArrayBuffer(tagBytes + (asize * 8));
            this.arrTags = new Uint8Array(buffer, 0, asize);
            this.arrValsF64 = new Float64Array(buffer, tagBytes, asize);
            this.arrRefs = new Array(asize).fill(null);
            this.arr = null;
        } else if (asize > 0) {
            this.arrTags = null;
            this.arrValsF64 = null;
            this.arrRefs = null;
            this.arr = new Array(asize * 2);
            for (let i = 0; i < asize * 2; i += 2) {
                this.arr[i] = LUA_TNIL;
                this.arr[i + 1] = null;
            }
        } else {
            this.arrTags = null;
            this.arrValsF64 = null;
            this.arrRefs = null;
            this.arr = null;
        }
        this._strong = null;
        this.dead_strong = null;
        this.dead_weak = void 0; /* initialised when needed */
        this.f = void 0; /* first entry */
        this.l = void 0; /* last entry */
        this.metatable = null;
        this.flags = ~0;
    }

    get strong() {
        return new TableStrongView(this);
    }

    set strong(v) {
        this._strong = v;
    }
}

const invalidateTMcache = function(t) {
    t.flags = 0;
};

const add = function(t, hash, key, value) {
    if (!t._strong) t._strong = new Map();
    if (t.dead_strong) t.dead_strong.clear();
    t.dead_weak = void 0;
    let prev = null;
    let entry = {
        key: key,
        value: value,
        p: prev = t.l,
        n: void 0
    };
    if (!t.f) t.f = entry;
    if (prev) prev.n = entry;
    t._strong.set(hash, entry);
    t.l = entry;
};

const is_valid_weakmap_key = function(k) {
    return typeof k === 'object' ? k !== null : typeof k === 'function';
};

/* Move out of 'strong' part and into 'dead' part. */
const mark_dead = function(t, hash) {
    if (!t._strong) return;
    let e = t._strong.get(hash);
    if (e) {
        e.key.setdeadvalue();
        e.value = void 0;
        let next = e.n;
        let prev = e.p;
        e.p = void 0; /* no need to know previous item any more */
        if(prev) prev.n = next;
        if(next) next.p = prev;
        if(t.f === e) t.f = next;
        if(t.l === e) t.l = prev;
        t._strong.delete(hash);
        if (is_valid_weakmap_key(hash)) {
            if (!t.dead_weak) t.dead_weak = new WeakMap();
            t.dead_weak.set(hash, e);
        } else {
            /* can't be used as key in weakmap */
            if (!t.dead_strong) t.dead_strong = new Map();
            t.dead_strong.set(hash, e);
        }
    }
};

const luaH_new = function(L, asize = 0) {
    return new Table(L, asize);
};

const luaH_resizearray = function(L, t, nasize) {
    const oldAsize = t.asize;
    if (nasize > 8) {
        const tagBytes = (nasize + 7) & ~7;
        const buffer = new ArrayBuffer(tagBytes + (nasize * 8));
        const newTags = new Uint8Array(buffer, 0, nasize);
        const newValsF64 = new Float64Array(buffer, tagBytes, nasize);
        const newRefs = new Array(nasize).fill(null);

        if (oldAsize > 0) {
            const copyCount = Math.min(oldAsize, nasize);
            if (t.arr) {
                for (let i = 0; i < copyCount; i++) {
                    const tag = t.arr[i * 2];
                    const val = t.arr[i * 2 + 1];
                    newTags[i] = tag;
                    if (tag === LUA_TNUMINT || tag === LUA_TNUMFLT) newValsF64[i] = val;
                    else if (tag === LUA_TBOOLEAN) newValsF64[i] = val ? 1 : 0;
                    else { newValsF64[i] = 0; newRefs[i] = val; }
                }
            } else if (t.arrTags) {
                newTags.set(t.arrTags.subarray(0, copyCount));
                newValsF64.set(t.arrValsF64.subarray(0, copyCount));
                for (let i = 0; i < copyCount; i++) {
                    newRefs[i] = t.arrRefs[i];
                }
            }
        }

        // Migrate any integer keys from hash map into newly expanded array partition
        if (t._strong) {
            for (let i = oldAsize + 1; i <= nasize; i++) {
                let e = t._strong.get(i);
                if (e && e.value && !e.value.ttisnil()) {
                    const idx = i - 1;
                    const tv = e.value;
                    newTags[idx] = tv.type;
                    if (tv.type === LUA_TNUMINT || tv.type === LUA_TNUMFLT) newValsF64[idx] = tv.value;
                    else if (tv.type === LUA_TBOOLEAN) newValsF64[idx] = tv.value ? 1 : 0;
                    else newRefs[idx] = tv.value;
                    mark_dead(t, i);
                }
            }
        }

        t.asize = nasize;
        t.arrTags = newTags;
        t.arrValsF64 = newValsF64;
        t.arrRefs = newRefs;
        t.arr = null;
    } else if (nasize > 0) {
        const newArr = new Array(nasize * 2);
        for (let i = 0; i < nasize * 2; i += 2) {
            newArr[i] = LUA_TNIL;
            newArr[i + 1] = null;
        }

        if (oldAsize > 0) {
            const copyCount = Math.min(oldAsize, nasize);
            if (t.arr) {
                for (let i = 0; i < copyCount * 2; i++) {
                    newArr[i] = t.arr[i];
                }
            } else if (t.arrTags) {
                for (let i = 0; i < copyCount; i++) {
                    const tag = t.arrTags[i];
                    newArr[i * 2] = tag;
                    newArr[i * 2 + 1] = t.arrRefs[i] !== null ? t.arrRefs[i] : (tag === LUA_TBOOLEAN ? (t.arrValsF64[i] !== 0) : t.arrValsF64[i]);
                }
            }
        }

        if (t._strong) {
            for (let i = oldAsize + 1; i <= nasize; i++) {
                let e = t._strong.get(i);
                if (e && e.value && !e.value.ttisnil()) {
                    const idx = i - 1;
                    const tv = e.value;
                    newArr[idx * 2] = tv.type;
                    newArr[idx * 2 + 1] = tv.value;
                    mark_dead(t, i);
                }
            }
        }

        t.asize = nasize;
        t.arr = newArr;
        t.arrTags = null;
        t.arrValsF64 = null;
        t.arrRefs = null;
    } else {
        t.asize = 0;
        t.arr = null;
        t.arrTags = null;
        t.arrValsF64 = null;
        t.arrRefs = null;
    }
};

const luaH_getint_isnil = function(t, key) {
    const idx = (key - 1) >>> 0;
    if (idx < t.asize) {
        if (t.arr) return t.arr[idx * 2] === LUA_TNIL;
        return t.arrTags[idx] === LUA_TNIL;
    }
    if (!t._strong) return true;
    let e = t._strong.get(key);
    return !e || !e.value || e.value.ttisnil();
};

const luaH_getint_to_stack = function(t, key, stack, dstSlot) {
    const idx = (key - 1) >>> 0;
    if (idx < t.asize) {
        if (t.arr) {
            const baseIdx = idx * 2;
            const tag = t.arr[baseIdx];
            if (tag === LUA_TNIL) return false;
            const val = t.arr[baseIdx + 1];
            stack.tags[dstSlot] = tag;
            if (tag === LUA_TNUMINT || tag === LUA_TNUMFLT) {
                stack.valsF64[dstSlot] = val;
                stack.refs[dstSlot] = null;
            } else if (tag === LUA_TBOOLEAN) {
                stack.valsF64[dstSlot] = val ? 1 : 0;
                stack.refs[dstSlot] = null;
            } else {
                stack.valsF64[dstSlot] = 0;
                stack.refs[dstSlot] = val;
            }
            let tv = stack[dstSlot];
            if (tv) {
                tv.type = tag;
                tv.value = (tag === LUA_TBOOLEAN) ? (val ? true : false) : val;
            }
            return true;
        }
        const tag = t.arrTags[idx];
        if (tag === LUA_TNIL) {
            return false;
        }
        stack.tags[dstSlot] = tag;
        stack.valsF64[dstSlot] = t.arrValsF64[idx];
        stack.refs[dstSlot] = t.arrRefs[idx];
        let tv = stack[dstSlot];
        if (tv) {
            tv.type = tag;
            tv.value = (tag === LUA_TNUMINT || tag === LUA_TNUMFLT) ? t.arrValsF64[idx] : (tag === LUA_TNIL ? null : (tag === LUA_TBOOLEAN ? (t.arrValsF64[idx] !== 0) : t.arrRefs[idx]));
        }
        return true;
    }
    if (!t._strong) return false;
    let e = t._strong.get(key);
    if (e && e.value && !e.value.ttisnil()) {
        const tv = e.value;
        stack.tags[dstSlot] = tv.type;
        stack.valsF64[dstSlot] = (tv.type === LUA_TNUMINT || tv.type === LUA_TNUMFLT) ? tv.value : (tv.type === LUA_TBOOLEAN ? (tv.value ? 1 : 0) : 0);
        stack.refs[dstSlot] = (tv.type >= LUA_TTABLE || tv.type === LUA_TLNGSTR || tv.type === LUA_TSHRSTR || tv.type === LUA_TUSERDATA || tv.type === LUA_TLIGHTUSERDATA || tv.type === LUA_TTHREAD) ? tv.value : null;
        let dstTv = stack[dstSlot];
        if (dstTv) { dstTv.type = tv.type; dstTv.value = tv.value; }
        return true;
    }
    return false;
};

const luaH_setint_from_stack = function(L, t, key, stack, slotC, isKC, k, kTags, kVals) {
    let srcTag, srcValF64, srcRef;
    if (isKC) {
        srcTag = kTags ? kTags[slotC] : k[slotC].type;
        srcValF64 = kVals ? kVals[slotC] : ((srcTag === LUA_TNUMINT || srcTag === LUA_TNUMFLT) ? k[slotC].value : (srcTag === LUA_TBOOLEAN ? (k[slotC].value ? 1 : 0) : 0));
        srcRef = (srcTag >= LUA_TTABLE || srcTag === LUA_TLNGSTR || srcTag === LUA_TSHRSTR || srcTag === LUA_TUSERDATA || srcTag === LUA_TLIGHTUSERDATA || srcTag === LUA_TTHREAD) ? k[slotC].value : null;
    } else {
        srcTag = stack.tags[slotC];
        srcValF64 = stack.valsF64[slotC];
        srcRef = (srcTag >= LUA_TTABLE || srcTag === LUA_TLNGSTR || srcTag === LUA_TSHRSTR || srcTag === LUA_TUSERDATA || srcTag === LUA_TLIGHTUSERDATA || srcTag === LUA_TTHREAD) ? stack.refs[slotC] : null;
    }

    const idx = (key - 1) >>> 0;
    if (idx < t.asize) {
        if (t.arr) {
            const baseIdx = idx * 2;
            t.arr[baseIdx] = srcTag;
            t.arr[baseIdx + 1] = (srcRef !== null) ? srcRef : ((srcTag === LUA_TBOOLEAN) ? (srcValF64 !== 0) : srcValF64);
            return true;
        }
        t.arrTags[idx] = srcTag;
        t.arrValsF64[idx] = srcValF64;
        t.arrRefs[idx] = srcRef;
        return true;
    }

    // Auto-grow array partition if key is positive and within sequential growth bounds
    if (srcTag !== LUA_TNIL && key > 0 && ((t.asize === 0 && key <= 4) || (key <= t.asize + 2))) {
        luaH_resizearray(L, t, Math.max(4, Math.max(key, t.asize << 1)));
        const newIdx = key - 1;
        if (t.arr) {
            const baseIdx = newIdx * 2;
            t.arr[baseIdx] = srcTag;
            t.arr[baseIdx + 1] = (srcRef !== null) ? srcRef : ((srcTag === LUA_TBOOLEAN) ? (srcValF64 !== 0) : srcValF64);
            return true;
        }
        t.arrTags[newIdx] = srcTag;
        t.arrValsF64[newIdx] = srcValF64;
        t.arrRefs[newIdx] = srcRef;
        return true;
    }

    // Hash fallback
    let tv = isKC ? k[slotC] : (stack.getTValue ? stack.getTValue(slotC) : stack[slotC]);
    if (!tv) {
        tv = new lobject.TValue(srcTag, srcRef !== null ? srcRef : (srcTag === LUA_TBOOLEAN ? (srcValF64 !== 0) : srcValF64));
    }
    luaH_setint(t, key, tv);
    return true;
};

const getgeneric = function(t, hash) {
    if (!t._strong) return lobject.luaO_nilobject;
    let v = t._strong.get(hash);
    return v ? v.value : lobject.luaO_nilobject;
};

const luaH_getint = function(t, key) {
    lua_assert(typeof key == "number" && (key|0) === key);
    const idx = (key - 1) >>> 0;
    if (idx < t.asize) {
        if (t.arr) {
            const baseIdx = idx * 2;
            const tag = t.arr[baseIdx];
            if (tag === LUA_TNIL) return lobject.luaO_nilobject;
            const val = t.arr[baseIdx + 1];
            return new lobject.TValue(tag, (tag === LUA_TBOOLEAN) ? (val ? true : false) : val);
        }
        const tag = t.arrTags[idx];
        if (tag === LUA_TNIL) return lobject.luaO_nilobject;
        let val = (tag === LUA_TNUMINT || tag === LUA_TNUMFLT) ? t.arrValsF64[idx] : (tag === LUA_TNIL ? null : (tag === LUA_TBOOLEAN ? (t.arrValsF64[idx] !== 0) : t.arrRefs[idx]));
        return new lobject.TValue(tag, val);
    }
    return getgeneric(t, key);
};

const luaH_getstr = function(t, key) {
    lua_assert(key instanceof TString);
    return getgeneric(t, luaS_hashlongstr(key));
};

const luaH_get = function(L, t, key) {
    lua_assert(key instanceof lobject.TValue);
    if (key.ttisnil() || (key.ttisfloat() && isNaN(key.value)))
        return lobject.luaO_nilobject;
    let keyInt = null;
    if (key.ttisinteger()) {
        keyInt = key.value;
    } else if (key.ttisfloat() && (key.value | 0) === key.value) {
        keyInt = key.value | 0;
    }
    if (keyInt !== null) {
        return luaH_getint(t, keyInt);
    }
    return getgeneric(t, table_hash(L, key));
};

const luaH_setint = function(t, key, value) {
    lua_assert(typeof key == "number" && (key|0) === key && value instanceof lobject.TValue);
    if (t._l_G && key === LUA_RIDX_GLOBALS && t._l_G._globalsTV) {
        t._l_G._globalsTV.setfrom(value);
    }
    const idx = (key - 1) >>> 0;
    if (idx < t.asize) {
        if (t.arr) {
            const baseIdx = idx * 2;
            t.arr[baseIdx] = value.type;
            t.arr[baseIdx + 1] = value.value;
            return;
        }
        t.arrTags[idx] = value.type;
        if (value.type === LUA_TNUMINT || value.type === LUA_TNUMFLT) t.arrValsF64[idx] = value.value;
        else if (value.type === LUA_TBOOLEAN) t.arrValsF64[idx] = value.value ? 1 : 0;
        else t.arrValsF64[idx] = 0;
        t.arrRefs[idx] = (value.type >= LUA_TTABLE || value.type === LUA_TLNGSTR || value.type === LUA_TSHRSTR || value.type === LUA_TUSERDATA || value.type === LUA_TLIGHTUSERDATA || value.type === LUA_TTHREAD) ? value.value : null;
        return;
    }
    if (!value.ttisnil() && key > 0 && ((t.asize === 0 && key <= 4) || (key <= t.asize + 2))) {
        luaH_resizearray(null, t, Math.max(4, Math.max(key, t.asize << 1)));
        const newIdx = key - 1;
        if (t.arr) {
            const baseIdx = newIdx * 2;
            t.arr[baseIdx] = value.type;
            t.arr[baseIdx + 1] = value.value;
            return;
        }
        t.arrTags[newIdx] = value.type;
        if (value.type === LUA_TNUMINT || value.type === LUA_TNUMFLT) t.arrValsF64[newIdx] = value.value;
        else if (value.type === LUA_TBOOLEAN) t.arrValsF64[newIdx] = value.value ? 1 : 0;
        else t.arrValsF64[newIdx] = 0;
        t.arrRefs[newIdx] = (value.type >= LUA_TTABLE || value.type === LUA_TLNGSTR || value.type === LUA_TSHRSTR || value.type === LUA_TUSERDATA || value.type === LUA_TLIGHTUSERDATA || value.type === LUA_TTHREAD) ? value.value : null;
        return;
    }
    let hash = key; /* table_hash known result */
    if (value.ttisnil()) {
        mark_dead(t, hash);
        return;
    }
    if (!t._strong) t._strong = new Map();
    let e = t._strong.get(hash);
    if (e) {
        let tv = e.value;
        tv.setfrom(value);
    } else {
        let k = lobject.luaO_acquire(null, LUA_TNUMINT, key);
        let v = lobject.luaO_acquire(null, value.type, value.value);
        add(t, hash, k, v);
    }
};

const luaH_setfrom = function(L, t, key, value) {
    lua_assert(key instanceof lobject.TValue);
    if (key.ttisinteger()) {
        luaH_setint(t, key.value, value);
        return;
    }
    if (key.ttisfloat() && (key.value | 0) === key.value) {
        luaH_setint(t, key.value | 0, value);
        return;
    }
    let hash = table_hash(L, key);
    if (value.ttisnil()) { /* delete */
        mark_dead(t, hash);
        return;
    }

    if (!t._strong) t._strong = new Map();
    let e = t._strong.get(hash);
    if (e) {
        e.value.setfrom(value);
    } else {
        let k = lobject.luaO_acquire(L, key.type, key.value);
        let v = lobject.luaO_acquire(L, value.type, value.value);
        add(t, hash, k, v);
    }
};

/*
** Try to find a boundary in table 't'. A 'boundary' is an integer index
** such that t[i] is non-nil and t[i+1] is nil (and 0 if t[1] is nil).
*/
const luaH_getn = function(t) {
    const asize = t.asize;
    const lastSlotNil = asize > 0 && (t.arr ? t.arr[(asize - 1) * 2] === LUA_TNIL : t.arrTags[asize - 1] === LUA_TNIL);
    if (asize > 0 && !lastSlotNil) {
        // No hole at the end of array part: search hash part if non-empty
        if (!t._strong || t._strong.size === 0) return asize;
        let i = asize;
        let j = asize * 2;
        while (!luaH_getint_isnil(t, j)) {
            i = j;
            if (j > LUA_MAXINTEGER / 2) {
                i = 1;
                while (!luaH_getint_isnil(t, i)) i++;
                return i - 1;
            }
            j *= 2;
        }
        while (j - i > 1) {
            let m = Math.floor((i + j) / 2);
            if (luaH_getint_isnil(t, m)) j = m;
            else i = m;
        }
        return i;
    }
    if (asize === 0 && !luaH_getint_isnil(t, 1)) {
        let i = 1;
        let j = (t._strong ? t._strong.size : 0) + 1;
        while (!luaH_getint_isnil(t, j)) {
            i = j;
            if (j > LUA_MAXINTEGER / 2) {
                i = 1;
                while (!luaH_getint_isnil(t, i)) i++;
                return i - 1;
            }
            j *= 2;
        }
        while (j - i > 1) {
            let m = Math.floor((i + j) / 2);
            if (luaH_getint_isnil(t, m)) j = m;
            else i = m;
        }
        return i;
    }
    // Boundary lies within the array part: binary search directly
    let i = 0;
    let j = asize + 1;
    while (j - i > 1) {
        let m = (i + j) >>> 1;
        let isNil = false;
        if (m > 0) {
            if (m > asize) isNil = true;
            else if (t.arr) isNil = (t.arr[(m - 1) * 2] === LUA_TNIL);
            else isNil = (t.arrTags[m - 1] === LUA_TNIL);
        }
        if (isNil) {
            j = m;
        } else {
            i = m;
        }
    }
    return i;
};

const luaH_next = function(L, table, keyI) {
    let keyO = L.stack.getTValue ? L.stack.getTValue(keyI) : L.stack[keyI];

    let entry;
    if (keyO.type === LUA_TNIL) {
        if (table.asize > 0) {
            let idx = 0;
            while (idx < table.asize && (table.arr ? table.arr[idx * 2] === LUA_TNIL : table.arrTags[idx] === LUA_TNIL)) idx++;
            if (idx < table.asize) {
                L.stack[keyI].setivalue(idx + 1);
                let tag, val;
                if (table.arr) {
                    tag = table.arr[idx * 2];
                    val = table.arr[idx * 2 + 1];
                } else {
                    tag = table.arrTags[idx];
                    val = table.arrRefs[idx] !== null ? table.arrRefs[idx] : (tag === LUA_TBOOLEAN ? (table.arrValsF64[idx] !== 0) : table.arrValsF64[idx]);
                }
                let slotVal = L.stack[keyI + 1];
                if (!slotVal) L.stack[keyI + 1] = new lobject.TValue(tag, (tag === LUA_TBOOLEAN) ? (val ? true : false) : val);
                else { slotVal.type = tag; slotVal.value = (tag === LUA_TBOOLEAN) ? (val ? true : false) : val; }
                if (L.stack.syncFromTValue) {
                    L.stack.syncFromTValue(keyI);
                    L.stack.syncFromTValue(keyI + 1);
                }
                return true;
            }
        }
        entry = table.f;
        if (!entry)
            return false;
    } else {
        let isIntKey = false;
        let keyInt = 0;
        if (keyO.type === LUA_TNUMINT) {
            isIntKey = true;
            keyInt = keyO.value;
        } else if (keyO.type === LUA_TNUMFLT && (keyO.value | 0) === keyO.value) {
            isIntKey = true;
            keyInt = keyO.value | 0;
        }

        if (isIntKey) {
            let idx = (keyInt - 1) >>> 0;
            if (idx < table.asize) {
                let nextIdx = idx + 1;
                while (nextIdx < table.asize && (table.arr ? table.arr[nextIdx * 2] === LUA_TNIL : table.arrTags[nextIdx] === LUA_TNIL)) nextIdx++;
                if (nextIdx < table.asize) {
                    L.stack[keyI].setivalue(nextIdx + 1);
                    let tag, val;
                    if (table.arr) {
                        tag = table.arr[nextIdx * 2];
                        val = table.arr[nextIdx * 2 + 1];
                    } else {
                        tag = table.arrTags[nextIdx];
                        val = table.arrRefs[nextIdx] !== null ? table.arrRefs[nextIdx] : (tag === LUA_TBOOLEAN ? (table.arrValsF64[nextIdx] !== 0) : table.arrValsF64[nextIdx]);
                    }
                    let slotVal = L.stack[keyI + 1];
                    if (!slotVal) L.stack[keyI + 1] = new lobject.TValue(tag, (tag === LUA_TBOOLEAN) ? (val ? true : false) : val);
                    else { slotVal.type = tag; slotVal.value = (tag === LUA_TBOOLEAN) ? (val ? true : false) : val; }
                    if (L.stack.syncFromTValue) {
                        L.stack.syncFromTValue(keyI);
                        L.stack.syncFromTValue(keyI + 1);
                    }
                    return true;
                }
                // Array part completed: move to hash part
                entry = table.f;
                if (!entry) return false;
                while (entry && entry.key.ttisdeadkey()) entry = entry.n;
                if (!entry) return false;
                lobject.setobj2s(L, keyI, entry.key);
                lobject.setobj2s(L, keyI + 1, entry.value);
                if (L.stack.syncFromTValue) {
                    L.stack.syncFromTValue(keyI);
                    L.stack.syncFromTValue(keyI + 1);
                }
                return true;
            }
        }

        /* First find current key in hash part */
        if (!table._strong) return ldebug.luaG_runerror(L, to_luastring("invalid key to 'next'"));
        let hash = table_hash(L, keyO);
        entry = table._strong.get(hash);
        if (entry) {
            entry = entry.n;
            if (!entry)
                return false;
        } else {
            /* Try dead keys */
            entry = (table.dead_weak && table.dead_weak.get(hash)) || (table.dead_strong && table.dead_strong.get(hash));
            if (!entry)
                return ldebug.luaG_runerror(L, to_luastring("invalid key to 'next'"));
            do {
                entry = entry.n;
                if (!entry)
                    return false;
            } while (entry.key.ttisdeadkey());
        }
    }
    lobject.setobj2s(L, keyI, entry.key);
    lobject.setobj2s(L, keyI+1, entry.value);
    return true;
};

module.exports.invalidateTMcache = invalidateTMcache;
module.exports.luaH_get     = luaH_get;
module.exports.luaH_getint  = luaH_getint;
module.exports.luaH_getint_isnil = luaH_getint_isnil;
module.exports.luaH_getint_to_stack = luaH_getint_to_stack;
module.exports.luaH_setint_from_stack = luaH_setint_from_stack;
module.exports.luaH_resizearray = luaH_resizearray;
module.exports.luaH_getn    = luaH_getn;
module.exports.luaH_getstr  = luaH_getstr;
module.exports.luaH_setfrom = luaH_setfrom;
module.exports.luaH_setint  = luaH_setint;
module.exports.luaH_new     = luaH_new;
module.exports.luaH_next    = luaH_next;
module.exports.Table        = Table;
