"use strict";

const {
    is_luastring,
    luastring_eq,
    luastring_from,
    to_luastring,
    to_jsstring
} = require('./defs.js');
const { lua_assert } = require("./llimits.js");

class TString {

    constructor(L, str) {
        this.hash = null;
        this.realstring = str;
        this.jsstring_cache = null;
    }

    getstr() {
        return this.realstring;
    }

    tsslen() {
        return this.realstring.length;
    }

    tojsstring() {
        if (this.jsstring_cache === null) {
            this.jsstring_cache = to_jsstring(this.realstring, void 0, void 0, true);
        }
        return this.jsstring_cache;
    }

}

const luaS_eqlngstr = function(a, b) {
    lua_assert(a instanceof TString);
    lua_assert(b instanceof TString);
    return a == b || luastring_eq(a.realstring, b.realstring);
};

const latin1_decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("latin1") : null;

/* converts strings (arrays) to a consistent map key
   make sure this doesn't conflict with any of the anti-collision strategies in ltable */
const luaS_hash = function(str) {
    lua_assert(is_luastring(str));
    if (latin1_decoder) {
        return "|" + latin1_decoder.decode(str);
    }
    let len = str.length;
    let s = "|";
    for (let i = 0; i < len; i++)
        s += String.fromCharCode(str[i]);
    return s;
};

const luaS_hashlongstr = function(ts) {
    lua_assert(ts instanceof TString);
    if(ts.hash === null) {
        ts.hash = luaS_hash(ts.getstr());
    }
    return ts.hash;
};

/* variant that takes ownership of array */
const luaS_bless = function(L, str) {
    lua_assert(str instanceof Uint8Array);
    if (str._ts) return str._ts;
    const ts = new TString(L, str);
    str._ts = ts;
    return ts;
};

/* makes a copy (or reuses cached TString if present on immutable cached luastring) */
const luaS_new = function(L, str) {
    if (str instanceof Uint8Array && str._ts) return str._ts;
    const ts = luaS_bless(L, luastring_from(str));
    if (str instanceof Uint8Array) str._ts = ts;
    return ts;
};

/* takes a js string */
const luaS_newliteral = function(L, str) {
    let u8 = to_luastring(str);
    if (u8._ts) {
        if (!u8._ts.jsstring_cache) u8._ts.jsstring_cache = str;
        return u8._ts;
    }
    let ts = luaS_bless(L, u8);
    ts.jsstring_cache = str;
    return ts;
};

module.exports.luaS_eqlngstr    = luaS_eqlngstr;
module.exports.luaS_hash        = luaS_hash;
module.exports.luaS_hashlongstr = luaS_hashlongstr;
module.exports.luaS_bless       = luaS_bless;
module.exports.luaS_new         = luaS_new;
module.exports.luaS_newliteral  = luaS_newliteral;
module.exports.TString          = TString;
