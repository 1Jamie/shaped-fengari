"use strict";

const {
    LUA_MASKLINE,
    LUA_MASKCOUNT,
    LUA_MULTRET,
    constant_types: {
        LUA_TBOOLEAN,
        LUA_TLCF,
        LUA_TLCL,
        LUA_TLIGHTUSERDATA,
        LUA_TLNGSTR,
        LUA_TNIL,
        LUA_TNUMBER,
        LUA_TNUMFLT,
        LUA_TNUMINT,
        LUA_TSHRSTR,
        LUA_TSTRING,
        LUA_TTABLE,
        LUA_TUSERDATA
    },
    to_luastring
} = require('./defs.js');
const {
    INDEXK,
    ISK,
    LFIELDS_PER_FLUSH,
    OpCodesI: {
        OP_ADD,
        OP_BAND,
        OP_BNOT,
        OP_BOR,
        OP_BXOR,
        OP_CALL,
        OP_CLOSURE,
        OP_CONCAT,
        OP_DIV,
        OP_EQ,
        OP_EXTRAARG,
        OP_FORLOOP,
        OP_FORPREP,
        OP_GETTABLE,
        OP_GETTABUP,
        OP_GETUPVAL,
        OP_IDIV,
        OP_JMP,
        OP_LE,
        OP_LEN,
        OP_LOADBOOL,
        OP_LOADK,
        OP_LOADKX,
        OP_LOADNIL,
        OP_LT,
        OP_MOD,
        OP_MOVE,
        OP_MUL,
        OP_NEWTABLE,
        OP_NOT,
        OP_POW,
        OP_RETURN,
        OP_SELF,
        OP_SETLIST,
        OP_SETTABLE,
        OP_SETTABUP,
        OP_SETUPVAL,
        OP_SHL,
        OP_SHR,
        OP_SUB,
        OP_TAILCALL,
        OP_TEST,
        OP_TESTSET,
        OP_TFORCALL,
        OP_TFORLOOP,
        OP_UNM,
        OP_VARARG
    }
} = require('./lopcodes.js');
const {
    LUA_MAXINTEGER,
    LUA_MININTEGER,
    MIN_INT_FLT,
    MAX_INT_FLT,
    lua_numbertointeger
} = require('./luaconf.js');
const {
    lua_assert,
    luai_nummod
} = require('./llimits.js');
const lobject = require('./lobject.js');
const lfunc   = require('./lfunc.js');
const lstate  = require('./lstate.js');
const {
    luaS_bless,
    luaS_eqlngstr,
    luaS_hashlongstr,
    luaS_new
} = require('./lstring.js');
const ldo     = require('./ldo.js');
const ltm     = require('./ltm.js');
const ltable  = require('./ltable.js');
const ldebug  = require('./ldebug.js');
const empty_u8 = new Uint8Array(0);

/*
** finish execution of an opcode interrupted by an yield
*/
const luaV_finishOp = function(L) {
    let ci = L.ci;
    let base = ci.l_base;
    let inst = ci.l_code[ci.l_savedpc - 1];  /* interrupted instruction */
    let op = inst.opcode;

    switch (op) {  /* finish its execution */
        case OP_ADD: case OP_SUB: case OP_MUL: case OP_DIV: case OP_IDIV:
        case OP_BAND: case OP_BOR: case OP_BXOR: case OP_SHL: case OP_SHR:
        case OP_MOD: case OP_POW:
        case OP_UNM: case OP_BNOT: case OP_LEN:
        case OP_GETTABUP: case OP_GETTABLE: case OP_SELF: {
            lobject.setobjs2s(L, base + inst.A, L.top-1);
            --L.top;
            break;
        }
        case OP_LE: case OP_LT: case OP_EQ: {
            let res = !L.stack.getTValue(L.top - 1).l_isfalse();
            --L.top;
            if (ci.callstatus & lstate.CIST_LEQ) {  /* "<=" using "<" instead? */
                lua_assert(op === OP_LE);
                ci.callstatus ^= lstate.CIST_LEQ;  /* clear mark */
                res = !res;  /* negate result */
            }
            lua_assert(ci.l_code[ci.l_savedpc].opcode === OP_JMP);
            if (res !== (inst.A ? true : false))  /* condition failed? */
                ci.l_savedpc++;  /* skip jump instruction */
            break;
        }
        case OP_CONCAT: {
            let top = L.top - 1;  /* top when 'luaT_trybinTM' was called */
            let b = inst.B;  /* first element to concatenate */
            let total = top - 1 - (base + b);  /* yet to concatenate */
            lobject.setobjs2s(L, top - 2, top);  /* put TM result in proper position */
            if (total > 1) {  /* are there elements to concat? */
                L.top = top - 1;  /* top is one after last element (at top-2) */
                luaV_concat(L, total);  /* concat them (may yield again) */
            }
            /* move final result to final position */
            lobject.setobjs2s(L, ci.l_base + inst.A, L.top - 1);
            ldo.adjust_top(L, ci.top);  /* restore top */
            break;
        }
        case OP_TFORCALL: {
            lua_assert(ci.l_code[ci.l_savedpc].opcode === OP_TFORLOOP);
            ldo.adjust_top(L, ci.top);  /* correct top */
            break;
        }
        case OP_CALL: {
            if (inst.C - 1 >= 0)  /* nresults >= 0? */
                ldo.adjust_top(L, ci.top);  /* adjust results */
            break;
        }
    }
};

const RA = function(L, base, i) {
    return base + i.A;
};

const RB = function(L, base, i) {
    return base + i.B;
};

// const RC = function(L, base, i) {
//     return base + i.C;
// };

// const RKB = function(L, base, k, i) {
//     return ISK(i.B) ? k[INDEXK(i.B)] : (L.stack.getTValue ? L.stack.getTValue(base + i.B) : L.stack[base + i.B]);
// };

const RKC = function(L, base, k, i) {
    return ISK(i.C) ? k[INDEXK(i.C)] : (L.stack.getTValue ? L.stack.getTValue(base + i.C) : L.stack[base + i.C]);
};

const luaV_execute = function(L) {
    let ci = L.ci;

    ci.callstatus |= lstate.CIST_FRESH;
    newframe:
    for (;;) {
        const cfs = L.cfs;
        const fp = cfs.ptr - 8;
        const buf = cfs.ci_buffer;
        let funcOff = buf[fp];
        let base = buf[fp + 1];
        let frameTop = buf[fp + 2];
        let pc = buf[fp + 3];
        ci = L.ci;
        ci.funcOff = funcOff;
        ci.l_base = base;
        ci.top = frameTop;
        ci.l_savedpc = pc;

        let cl = cfs.ci_closures[fp >>> 3];
        if (!cl.p.kTags) lfunc.luaF_finishproto(cl.p);
        let k = cl.p.k;
        let kTags = cl.p.kTags;
        let kVals = cl.p.kVals;
        let kValsI64 = cl.p.kValsI64;
        let code = cl.p.code;
        let stack = L.stack.rawStack || L.stack;

        for (;;) {
            let i = code[pc++];
            ci.l_savedpc = pc;
            ci.l_base = base;

            if (L.hookmask & (LUA_MASKLINE | LUA_MASKCOUNT)) {
                ldebug.luaG_traceexec(L);
                pc = ci.l_savedpc;
                base = ci.l_base;
            }

            let ra = base + i.A;
            let opcode = i.opcode;

            switch (opcode) {
                case OP_MOVE: {
                    stack.copy(ra, base + i.B);
                    break;
                }
                case OP_LOADK: {
                    let bx = i.Bx;
                    let tag = kTags[bx];
                    if (tag === LUA_TNUMINT) {
                        stack.setInteger(ra, kValsI64[bx]);
                    } else if (tag === LUA_TNUMFLT) {
                        stack.setNumber(ra, kVals[bx]);
                    } else if (tag === LUA_TBOOLEAN) {
                        stack.setBoolean(ra, kVals[bx] !== 0);
                    } else {
                        let konst = k[bx];
                        stack.setObject(ra, konst.type, konst.value);
                    }
                    break;
                }
                case OP_LOADKX: {
                    lua_assert(code[pc].opcode === OP_EXTRAARG);
                    let ax = code[pc++].Ax;
                    let tag = kTags[ax];
                    if (tag === LUA_TNUMINT) {
                        stack.setInteger(ra, kValsI64[ax]);
                    } else if (tag === LUA_TNUMFLT) {
                        stack.setNumber(ra, kVals[ax]);
                    } else if (tag === LUA_TBOOLEAN) {
                        stack.setBoolean(ra, kVals[ax] !== 0);
                    } else {
                        let konst = k[ax];
                        stack.setObject(ra, konst.type, konst.value);
                    }
                    break;
                }
                case OP_LOADBOOL: {
                    stack.setBoolean(ra, i.B !== 0);
                    if (i.C !== 0)
                        pc++; /* skip next instruction (if C) */

                    break;
                }
                case OP_LOADNIL: {
                    for (let j = 0; j <= i.B; j++) {
                        stack.setNil(ra + j);
                    }
                    break;
                }
                case OP_GETUPVAL: {
                    cl.upvals[i.B].loadTo(stack, ra);
                    break;
                }
                case OP_GETTABUP: {
                    let upval = cl.upvals[i.B];
                    let c = i.C;
                    let isKC = (c & 0x100) !== 0;
                    let slotC = isKC ? (c & 0xFF) : (base + c);
                    let tagC = isKC ? kTags[slotC] : stack.tags[slotC];
                    let valC = isKC ? kVals[slotC] : stack.valsF64[slotC];
                    let keyInt = null;
                    if (tagC === LUA_TNUMINT) keyInt = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                    else if (tagC === LUA_TNUMFLT && valC >= MIN_INT_FLT && valC < MAX_INT_FLT && Number.isInteger(valC))
                        keyInt = BigInt(valC);
                    if (keyInt !== null && upval.type === LUA_TTABLE) {
                        let tableObj = upval.value;
                        if (ltable.luaH_getint_to_stack(tableObj, keyInt, stack, ra)) break;
                        if (tableObj.metatable === null || ltm.fasttm(L, tableObj.metatable, ltm.TMS.TM_INDEX) === null) {
                            stack.setNil(ra);
                            break;
                        }
                    }
                    let rc = isKC ? k[slotC] : stack.getTValue(slotC);
                    luaV_gettable(L, upval, rc, ra);
                    stack.syncFromTValue(ra);
                    break;
                }
                case OP_GETTABLE: {
                    let rbSlot = base + i.B;
                    let rbTag = stack.tags[rbSlot];
                    let c = i.C;
                    let isKC = (c & 0x100) !== 0;
                    let slotC = isKC ? (c & 0xFF) : (base + c);
                    let tagC = isKC ? kTags[slotC] : stack.tags[slotC];
                    let valC = isKC ? kVals[slotC] : stack.valsF64[slotC];

                    let isInt = false;
                    let keyInt = 0n;
                    if (tagC === LUA_TNUMINT) {
                        isInt = true;
                        keyInt = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                    } else if (tagC === LUA_TNUMFLT && valC >= MIN_INT_FLT && valC < MAX_INT_FLT && Number.isInteger(valC)) {
                        isInt = true;
                        keyInt = BigInt(valC);
                    }

                    if (isInt && rbTag === LUA_TTABLE) {
                        let tableObj = stack.refs[rbSlot];
                        let found = ltable.luaH_getint_to_stack(tableObj, keyInt, stack, ra);
                        if (found) break;
                        if (tableObj.metatable === null || ltm.fasttm(L, tableObj.metatable, ltm.TMS.TM_INDEX) === null) {
                            stack.setNil(ra);
                            break;
                        }
                    }

                    let rb = stack.getTValue(rbSlot);
                    let rc = isKC ? k[slotC] : stack.getTValue(slotC);
                    luaV_gettable(L, rb, rc, ra);
                    stack.syncFromTValue(ra);
                    break;
                }
                case OP_SETTABUP: {
                    let upval = cl.upvals[i.A];
                    let b = i.B;
                    let isKB = (b & 0x100) !== 0;
                    let slotB = isKB ? (b & 0xFF) : (base + b);
                    let tagB = isKB ? kTags[slotB] : stack.tags[slotB];
                    let valB = isKB ? kVals[slotB] : stack.valsF64[slotB];
                    let keyInt = null;
                    if (tagB === LUA_TNUMINT) keyInt = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                    else if (tagB === LUA_TNUMFLT && valB >= MIN_INT_FLT && valB < MAX_INT_FLT && Number.isInteger(valB))
                        keyInt = BigInt(valB);
                    let c = i.C;
                    let isKC = (c & 0x100) !== 0;
                    let slotC = isKC ? (c & 0xFF) : (base + c);
                    if (keyInt !== null && upval.type === LUA_TTABLE) {
                        let tableObj = upval.value;
                        if (tableObj.metatable === null || !ltable.luaH_getint_isnil(tableObj, keyInt) || ltm.fasttm(L, tableObj.metatable, ltm.TMS.TM_NEWINDEX) === null) {
                            ltable.luaH_setint_from_stack(L, tableObj, keyInt, stack, slotC, isKC, k, kTags, kVals);
                            ltable.invalidateTMcache(tableObj);
                            break;
                        }
                    }
                    let rb = isKB ? k[slotB] : stack.getTValue(slotB);
                    let rc = isKC ? k[slotC] : stack.getTValue(slotC);
                    settable(L, upval, rb, rc);
                    break;
                }
                case OP_SETUPVAL: {
                    cl.upvals[i.B].storeFrom(stack, ra);
                    break;
                }
                case OP_SETTABLE: {
                    let tableTag = stack.tags[ra];
                    let b = i.B;
                    let isKB = (b & 0x100) !== 0;
                    let slotB = isKB ? (b & 0xFF) : (base + b);
                    let tagB = isKB ? kTags[slotB] : stack.tags[slotB];
                    let valB = isKB ? kVals[slotB] : stack.valsF64[slotB];

                    let isInt = false;
                    let keyInt = 0n;
                    if (tagB === LUA_TNUMINT) {
                        isInt = true;
                        keyInt = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                    } else if (tagB === LUA_TNUMFLT && valB >= MIN_INT_FLT && valB < MAX_INT_FLT && Number.isInteger(valB)) {
                        isInt = true;
                        keyInt = BigInt(valB);
                    }

                    let c = i.C;
                    let isKC = (c & 0x100) !== 0;
                    let slotC = isKC ? (c & 0xFF) : (base + c);

                    if (isInt && tableTag === LUA_TTABLE) {
                        let tableObj = stack.refs[ra];
                        if (tableObj.metatable === null || !ltable.luaH_getint_isnil(tableObj, keyInt) || ltm.fasttm(L, tableObj.metatable, ltm.TMS.TM_NEWINDEX) === null) {
                            ltable.luaH_setint_from_stack(L, tableObj, keyInt, stack, slotC, isKC, k, kTags, kVals);
                            ltable.invalidateTMcache(tableObj);
                            break;
                        }
                    }

                    let table = stack.getTValue(ra);
                    let key = isKB ? k[slotB] : stack.getTValue(slotB);
                    let v = isKC ? k[slotC] : stack.getTValue(slotC);

                    settable(L, table, key, v);
                    break;
                }
                case OP_NEWTABLE: {
                    const asize = lobject.luaO_fb2int(i.B);
                    stack.setObject(ra, LUA_TTABLE, ltable.luaH_new(L, asize));
                    break;
                }
                case OP_SELF: {
                    let rb = RB(L, base, i);
                    let rc = RKC(L, base, k, i);
                    lobject.setobjs2s(L, ra + 1, rb);
                    luaV_gettable(L, L.stack[rb], rc, ra);
                    stack.syncFromTValue(ra);
                    break;
                }
                case OP_ADD: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if (tagB === LUA_TNUMINT && tagC === LUA_TNUMINT) {
                        const biB = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                        const biC = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                        stack.setInteger(ra, BigInt.asIntN(64, biB + biC));
                    } else if ((tagB === LUA_TNUMFLT || tagB === LUA_TNUMINT) &&
                           (tagC === LUA_TNUMFLT || tagC === LUA_TNUMINT)) {
                        const numB = (tagB === LUA_TNUMINT) ? (isKB ? kVals[slotB] : Number(stack.valsI64[slotB])) : (isKB ? kVals[slotB] : stack.valsF64[slotB]);
                        const numC = (tagC === LUA_TNUMINT) ? (isKC ? kVals[slotC] : Number(stack.valsI64[slotC])) : (isKC ? kVals[slotC] : stack.valsF64[slotC]);
                        stack.setNumber(ra, numB + numC);
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tonumber(op1)) !== false && (n2 = tonumber(op2)) !== false) {
                            stack.setNumber(ra, Number(n1) + Number(n2));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_ADD);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_SUB: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if (tagB === LUA_TNUMINT && tagC === LUA_TNUMINT) {
                        const biB = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                        const biC = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                        stack.setInteger(ra, BigInt.asIntN(64, biB - biC));
                    } else if ((tagB === LUA_TNUMFLT || tagB === LUA_TNUMINT) &&
                           (tagC === LUA_TNUMFLT || tagC === LUA_TNUMINT)) {
                        const numB = (tagB === LUA_TNUMINT) ? (isKB ? kVals[slotB] : Number(stack.valsI64[slotB])) : (isKB ? kVals[slotB] : stack.valsF64[slotB]);
                        const numC = (tagC === LUA_TNUMINT) ? (isKC ? kVals[slotC] : Number(stack.valsI64[slotC])) : (isKC ? kVals[slotC] : stack.valsF64[slotC]);
                        stack.setNumber(ra, numB - numC);
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tonumber(op1)) !== false && (n2 = tonumber(op2)) !== false) {
                            stack.setNumber(ra, Number(n1) - Number(n2));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_SUB);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_MUL: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if (tagB === LUA_TNUMINT && tagC === LUA_TNUMINT) {
                        const biB = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                        const biC = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                        stack.setInteger(ra, BigInt.asIntN(64, biB * biC));
                    } else if ((tagB === LUA_TNUMFLT || tagB === LUA_TNUMINT) &&
                           (tagC === LUA_TNUMFLT || tagC === LUA_TNUMINT)) {
                        const numB = (tagB === LUA_TNUMINT) ? (isKB ? kVals[slotB] : Number(stack.valsI64[slotB])) : (isKB ? kVals[slotB] : stack.valsF64[slotB]);
                        const numC = (tagC === LUA_TNUMINT) ? (isKC ? kVals[slotC] : Number(stack.valsI64[slotC])) : (isKC ? kVals[slotC] : stack.valsF64[slotC]);
                        stack.setNumber(ra, numB * numC);
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tonumber(op1)) !== false && (n2 = tonumber(op2)) !== false) {
                            stack.setNumber(ra, Number(n1) * Number(n2));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_MUL);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_MOD: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if (tagB === LUA_TNUMINT && tagC === LUA_TNUMINT) {
                        const biB = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                        const biC = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                        stack.setInteger(ra, luaV_mod(L, biB, biC));
                    } else if ((tagB === LUA_TNUMFLT || tagB === LUA_TNUMINT) &&
                           (tagC === LUA_TNUMFLT || tagC === LUA_TNUMINT)) {
                        const numB = (tagB === LUA_TNUMINT) ? (isKB ? kVals[slotB] : Number(stack.valsI64[slotB])) : (isKB ? kVals[slotB] : stack.valsF64[slotB]);
                        const numC = (tagC === LUA_TNUMINT) ? (isKC ? kVals[slotC] : Number(stack.valsI64[slotC])) : (isKC ? kVals[slotC] : stack.valsF64[slotC]);
                        stack.setNumber(ra, luai_nummod(L, numB, numC));
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tonumber(op1)) !== false && (n2 = tonumber(op2)) !== false) {
                            stack.setNumber(ra, luai_nummod(L, Number(n1), Number(n2)));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_MOD);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_POW: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if ((tagB === LUA_TNUMFLT || tagB === LUA_TNUMINT) &&
                    (tagC === LUA_TNUMFLT || tagC === LUA_TNUMINT)) {
                        const numB = (tagB === LUA_TNUMINT) ? (isKB ? kVals[slotB] : Number(stack.valsI64[slotB])) : (isKB ? kVals[slotB] : stack.valsF64[slotB]);
                        const numC = (tagC === LUA_TNUMINT) ? (isKC ? kVals[slotC] : Number(stack.valsI64[slotC])) : (isKC ? kVals[slotC] : stack.valsF64[slotC]);
                        stack.setNumber(ra, Math.pow(numB, numC));
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tonumber(op1)) !== false && (n2 = tonumber(op2)) !== false) {
                            stack.setNumber(ra, Math.pow(Number(n1), Number(n2)));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_POW);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_DIV: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if ((tagB === LUA_TNUMFLT || tagB === LUA_TNUMINT) &&
                    (tagC === LUA_TNUMFLT || tagC === LUA_TNUMINT)) {
                        const numB = (tagB === LUA_TNUMINT) ? (isKB ? kVals[slotB] : Number(stack.valsI64[slotB])) : (isKB ? kVals[slotB] : stack.valsF64[slotB]);
                        const numC = (tagC === LUA_TNUMINT) ? (isKC ? kVals[slotC] : Number(stack.valsI64[slotC])) : (isKC ? kVals[slotC] : stack.valsF64[slotC]);
                        stack.setNumber(ra, numB / numC);
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tonumber(op1)) !== false && (n2 = tonumber(op2)) !== false) {
                            stack.setNumber(ra, Number(n1) / Number(n2));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_DIV);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_IDIV: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if (tagB === LUA_TNUMINT && tagC === LUA_TNUMINT) {
                        const biB = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                        const biC = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                        stack.setInteger(ra, luaV_div(L, biB, biC));
                    } else if ((tagB === LUA_TNUMFLT || tagB === LUA_TNUMINT) &&
                           (tagC === LUA_TNUMFLT || tagC === LUA_TNUMINT)) {
                        const numB = (tagB === LUA_TNUMINT) ? (isKB ? kVals[slotB] : Number(stack.valsI64[slotB])) : (isKB ? kVals[slotB] : stack.valsF64[slotB]);
                        const numC = (tagC === LUA_TNUMINT) ? (isKC ? kVals[slotC] : Number(stack.valsI64[slotC])) : (isKC ? kVals[slotC] : stack.valsF64[slotC]);
                        stack.setNumber(ra, Math.floor(numB / numC));
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tonumber(op1)) !== false && (n2 = tonumber(op2)) !== false) {
                            stack.setNumber(ra, Math.floor(Number(n1) / Number(n2)));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_IDIV);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_BAND: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if (tagB === LUA_TNUMINT && tagC === LUA_TNUMINT) {
                        const biB = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                        const biC = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                        stack.setInteger(ra, BigInt.asIntN(64, biB & biC));
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tointeger(op1)) !== false && (n2 = tointeger(op2)) !== false) {
                            let bi1 = typeof n1 === "bigint" ? n1 : BigInt(n1);
                            let bi2 = typeof n2 === "bigint" ? n2 : BigInt(n2);
                            stack.setInteger(ra, BigInt.asIntN(64, bi1 & bi2));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_BAND);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_BOR: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if (tagB === LUA_TNUMINT && tagC === LUA_TNUMINT) {
                        const biB = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                        const biC = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                        stack.setInteger(ra, BigInt.asIntN(64, biB | biC));
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tointeger(op1)) !== false && (n2 = tointeger(op2)) !== false) {
                            let bi1 = typeof n1 === "bigint" ? n1 : BigInt(n1);
                            let bi2 = typeof n2 === "bigint" ? n2 : BigInt(n2);
                            stack.setInteger(ra, BigInt.asIntN(64, bi1 | bi2));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_BOR);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_BXOR: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if (tagB === LUA_TNUMINT && tagC === LUA_TNUMINT) {
                        const biB = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                        const biC = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                        stack.setInteger(ra, BigInt.asIntN(64, biB ^ biC));
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tointeger(op1)) !== false && (n2 = tointeger(op2)) !== false) {
                            let bi1 = typeof n1 === "bigint" ? n1 : BigInt(n1);
                            let bi2 = typeof n2 === "bigint" ? n2 : BigInt(n2);
                            stack.setInteger(ra, BigInt.asIntN(64, bi1 ^ bi2));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_BXOR);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_SHL: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if (tagB === LUA_TNUMINT && tagC === LUA_TNUMINT) {
                        const biB = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                        const biC = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                        stack.setInteger(ra, luaV_shiftl(biB, biC));
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tointeger(op1)) !== false && (n2 = tointeger(op2)) !== false) {
                            stack.setInteger(ra, luaV_shiftl(n1, n2));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_SHL);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_SHR: {
                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    if (tagB === LUA_TNUMINT && tagC === LUA_TNUMINT) {
                        const biB = isKB ? kValsI64[slotB] : stack.valsI64[slotB];
                        const biC = isKC ? kValsI64[slotC] : stack.valsI64[slotC];
                        stack.setInteger(ra, luaV_shiftl(biB, -biC));
                    } else {
                        let op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                        let op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                        let n1, n2;
                        if ((n1 = tointeger(op1)) !== false && (n2 = tointeger(op2)) !== false) {
                            let bi2 = typeof n2 === "bigint" ? n2 : BigInt(n2);
                            stack.setInteger(ra, luaV_shiftl(n1, -bi2));
                        } else {
                            ltm.luaT_trybinTM(L, op1, op2, stack.getTValue(ra), ltm.TMS.TM_SHR);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_UNM: {
                    let slotB = base + i.B;
                    let tag = stack.tags[slotB];
                    if (tag === LUA_TNUMINT) {
                        stack.setInteger(ra, BigInt.asIntN(64, -stack.valsI64[slotB]));
                    } else if (tag === LUA_TNUMFLT) {
                        stack.setNumber(ra, -stack.valsF64[slotB]);
                    } else {
                        let op = stack.getTValue(slotB);
                        let n;
                        if ((n = tonumber(op)) !== false) {
                            stack.setNumber(ra, -Number(n));
                        } else {
                            ltm.luaT_trybinTM(L, op, op, stack.getTValue(ra), ltm.TMS.TM_UNM);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_BNOT: {
                    let slotB = base + i.B;
                    let tag = stack.tags[slotB];
                    if (tag === LUA_TNUMINT) {
                        stack.setInteger(ra, BigInt.asIntN(64, ~stack.valsI64[slotB]));
                    } else {
                        let op = stack.getTValue(slotB);
                        let n;
                        if ((n = tointeger(op)) !== false) {
                            let bi = typeof n === "bigint" ? n : BigInt(n);
                            stack.setInteger(ra, BigInt.asIntN(64, ~bi));
                        } else {
                            ltm.luaT_trybinTM(L, op, op, stack.getTValue(ra), ltm.TMS.TM_BNOT);
                            stack.syncFromTValue(ra);
                        }
                    }
                    break;
                }
                case OP_NOT: {
                    let slotB = base + i.B;
                    let tag = stack.tags[slotB];
                    let isfalse = (tag === LUA_TNIL) || (tag === LUA_TBOOLEAN && stack.valsF64[slotB] === 0);
                    stack.setBoolean(ra, isfalse);
                    break;
                }
                case OP_LEN: {
                    let rb = RB(L, base, i);
                    luaV_objlen(L, stack.getTValue(ra), stack.getTValue(rb));
                    stack.syncFromTValue(ra);
                    break;
                }
                case OP_CONCAT: {
                    let b = i.B;
                    let c = i.C;
                    for (let s = b; s <= c; s++) {
                        stack.getTValue(base + s);
                    }
                    L.top = base + c + 1; /* mark the end of concat operands */
                    luaV_concat(L, c - b + 1);
                    let rb = base + b;
                    lobject.setobjs2s(L, ra, rb);
                    ldo.adjust_top(L, ci.top); /* restore top */
                    stack.syncFromTValue(ra);
                    break;
                }
                case OP_JMP: {
                    if (i.A !== 0) lfunc.luaF_close(L, ci.l_base + i.A - 1);
                    pc += i.sBx;
                    break;
                }
                case OP_EQ: {
                    if ((L.hookmask & (lstate.LUA_MASKLINE | lstate.LUA_MASKCOUNT)) !== 0) {
                        let b = i.B;
                        let op1 = (b & 0x100) ? k[b & 0xFF] : stack.getTValue(base + b);
                        let c = i.C;
                        let op2 = (c & 0x100) ? k[c & 0xFF] : stack.getTValue(base + c);
                        let res;
                        if (op1.type === op2.type && (op1.type === LUA_TNUMINT || op1.type === LUA_TNUMFLT || op1.type === LUA_TBOOLEAN)) {
                            res = (op1.value === op2.value) ? 1 : 0;
                        } else if ((op1.type === LUA_TNUMINT || op1.type === LUA_TNUMFLT) && (op2.type === LUA_TNUMINT || op2.type === LUA_TNUMFLT)) {
                            res = (op1.value == op2.value) ? 1 : 0;
                        } else {
                            res = luaV_equalobj(L, op1, op2);
                        }
                        if (res !== i.A)
                            pc++;
                        else
                            pc = donextjump(L, ci, pc, code);
                        break;
                    }

                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    const isNumB = (tagB === LUA_TNUMINT || tagB === LUA_TNUMFLT);
                    const isNumC = (tagC === LUA_TNUMINT || tagC === LUA_TNUMFLT);
                    if (isNumB && isNumC) {
                        const valB = (tagB === LUA_TNUMINT) ? (isKB ? kValsI64[slotB] : stack.valsI64[slotB]) : (isKB ? kVals[slotB] : stack.valsF64[slotB]);
                        const valC = (tagC === LUA_TNUMINT) ? (isKC ? kValsI64[slotC] : stack.valsI64[slotC]) : (isKC ? kVals[slotC] : stack.valsF64[slotC]);
                        const cond = (valB == valC);
                        if (cond !== (i.A !== 0)) {
                            pc++;
                        } else {
                            const jmpInst = code[pc];
                            if (jmpInst.A !== 0) lfunc.luaF_close(L, ci.l_base + jmpInst.A - 1);
                            pc += jmpInst.sBx + 1;
                        }
                        break;
                    } else if (tagB === tagC && tagB === LUA_TBOOLEAN) {
                        const valB = isKB ? kVals[slotB] : stack.valsF64[slotB];
                        const valC = isKC ? kVals[slotC] : stack.valsF64[slotC];
                        const cond = (valB === valC);
                        if (cond !== (i.A !== 0)) {
                            pc++;
                        } else {
                            const jmpInst = code[pc];
                            if (jmpInst.A !== 0) lfunc.luaF_close(L, ci.l_base + jmpInst.A - 1);
                            pc += jmpInst.sBx + 1;
                        }
                        break;
                    }

                    const op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                    const op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                    let res = luaV_equalobj(L, op1, op2);
                    if (res !== i.A)
                        pc++;
                    else
                        pc = donextjump(L, ci, pc, code);
                    break;
                }
                case OP_LT: {
                    if ((L.hookmask & (lstate.LUA_MASKLINE | lstate.LUA_MASKCOUNT)) !== 0) {
                        let b = i.B;
                        let op1 = (b & 0x100) ? k[b & 0xFF] : stack.getTValue(base + b);
                        let c = i.C;
                        let op2 = (c & 0x100) ? k[c & 0xFF] : stack.getTValue(base + c);
                        let res;
                        if ((op1.type === LUA_TNUMINT || op1.type === LUA_TNUMFLT) && (op2.type === LUA_TNUMINT || op2.type === LUA_TNUMFLT)) {
                            res = (op1.value < op2.value) ? 1 : 0;
                        } else {
                            res = luaV_lessthan(L, op1, op2);
                        }
                        if (res !== i.A)
                            pc++;
                        else
                            pc = donextjump(L, ci, pc, code);
                        break;
                    }

                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    const isNumB = (tagB === LUA_TNUMINT || tagB === LUA_TNUMFLT);
                    const isNumC = (tagC === LUA_TNUMINT || tagC === LUA_TNUMFLT);
                    if (isNumB && isNumC) {
                        const valB = (tagB === LUA_TNUMINT) ? (isKB ? kValsI64[slotB] : stack.valsI64[slotB]) : (isKB ? kVals[slotB] : stack.valsF64[slotB]);
                        const valC = (tagC === LUA_TNUMINT) ? (isKC ? kValsI64[slotC] : stack.valsI64[slotC]) : (isKC ? kVals[slotC] : stack.valsF64[slotC]);
                        const cond = valB < valC;
                        if (cond !== (i.A !== 0)) {
                            pc++;
                        } else {
                            const jmpInst = code[pc];
                            if (jmpInst.A !== 0) lfunc.luaF_close(L, ci.l_base + jmpInst.A - 1);
                            pc += jmpInst.sBx + 1;
                        }
                        break;
                    }

                    const op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                    const op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                    let res = luaV_lessthan(L, op1, op2);
                    if (res !== i.A)
                        pc++;
                    else
                        pc = donextjump(L, ci, pc, code);
                    break;
                }
                case OP_LE: {
                    if ((L.hookmask & (lstate.LUA_MASKLINE | lstate.LUA_MASKCOUNT)) !== 0) {
                        let b = i.B;
                        let op1 = (b & 0x100) ? k[b & 0xFF] : stack.getTValue(base + b);
                        let c = i.C;
                        let op2 = (c & 0x100) ? k[c & 0xFF] : stack.getTValue(base + c);
                        let res;
                        if ((op1.type === LUA_TNUMINT || op1.type === LUA_TNUMFLT) && (op2.type === LUA_TNUMINT || op2.type === LUA_TNUMFLT)) {
                            res = (op1.value <= op2.value) ? 1 : 0;
                        } else {
                            res = luaV_lessequal(L, op1, op2);
                        }
                        if (res !== i.A)
                            pc++;
                        else
                            pc = donextjump(L, ci, pc, code);
                        break;
                    }

                    const b = i.B;
                    const isKB = (b & 0x100) !== 0;
                    const slotB = isKB ? (b & 0xFF) : (base + b);
                    const tagB  = isKB ? kTags[slotB] : stack.tags[slotB];

                    const c = i.C;
                    const isKC = (c & 0x100) !== 0;
                    const slotC = isKC ? (c & 0xFF) : (base + c);
                    const tagC  = isKC ? kTags[slotC] : stack.tags[slotC];

                    const isNumB = (tagB === LUA_TNUMINT || tagB === LUA_TNUMFLT);
                    const isNumC = (tagC === LUA_TNUMINT || tagC === LUA_TNUMFLT);
                    if (isNumB && isNumC) {
                        const valB = (tagB === LUA_TNUMINT) ? (isKB ? kValsI64[slotB] : stack.valsI64[slotB]) : (isKB ? kVals[slotB] : stack.valsF64[slotB]);
                        const valC = (tagC === LUA_TNUMINT) ? (isKC ? kValsI64[slotC] : stack.valsI64[slotC]) : (isKC ? kVals[slotC] : stack.valsF64[slotC]);
                        const cond = valB <= valC;
                        if (cond !== (i.A !== 0)) {
                            pc++;
                        } else {
                            const jmpInst = code[pc];
                            if (jmpInst.A !== 0) lfunc.luaF_close(L, ci.l_base + jmpInst.A - 1);
                            pc += jmpInst.sBx + 1;
                        }
                        break;
                    }

                    const op1 = isKB ? k[slotB] : stack.getTValue(slotB);
                    const op2 = isKC ? k[slotC] : stack.getTValue(slotC);
                    let res = luaV_lessequal(L, op1, op2);
                    if (res !== i.A)
                        pc++;
                    else
                        pc = donextjump(L, ci, pc, code);
                    break;
                }
                case OP_TEST: {
                    if ((L.hookmask & (lstate.LUA_MASKLINE | lstate.LUA_MASKCOUNT)) !== 0) {
                        if (i.C ? stack.getTValue(ra).l_isfalse() : !stack.getTValue(ra).l_isfalse())
                            pc++;
                        else
                            pc = donextjump(L, ci, pc, code);
                        break;
                    }
                    const tag = stack.tags[ra];
                    const isfalse = (tag === LUA_TNIL) || (tag === LUA_TBOOLEAN && stack.valsF64[ra] === 0);
                    const cond = (i.C !== 0) ? isfalse : !isfalse;
                    const nextInst = cl.p.code[pc++];
                    if (!cond) {
                        if (nextInst.A !== 0) lfunc.luaF_close(L, ci.l_base + nextInst.A - 1);
                        pc += nextInst.sBx;
                    }
                    break;
                }
                case OP_TESTSET: {
                    let rbSlot = base + i.B;
                    let tag = stack.tags[rbSlot];
                    let isfalse = (tag === LUA_TNIL) || (tag === LUA_TBOOLEAN && stack.valsF64[rbSlot] === 0);
                    if (i.C ? isfalse : !isfalse)
                        pc++;
                    else {
                        stack.copy(ra, rbSlot);
                        pc = donextjump(L, ci, pc, code);
                    }
                    break;
                }
                case OP_CALL: {
                    let b = i.B;
                    let nresults = i.C - 1;

                    // Fast host intrinsics
                    let funcRef = stack.refs[ra] || (L.stack[ra] && L.stack[ra].value);
                    let fn = funcRef ? (funcRef.f || funcRef) : null;
                    if (fn && fn._is_str_byte && (b === 2 || b === 3) && nresults === 1) {
                        let sTag = stack.tags[ra + 1];
                        if (sTag === LUA_TSHRSTR || sTag === LUA_TLNGSTR) {
                            let ts = stack.refs[ra + 1] || (L.stack[ra + 1] && L.stack[ra + 1].value);
                            if (ts && ts.realstring) {
                                let u8 = ts.realstring;
                                let pos = 1;
                                let valid = true;
                                if (b === 3) {
                                    let posTag = stack.tags[ra + 2];
                                    if (posTag === LUA_TNUMINT) {
                                        pos = Number(stack.valsI64[ra + 2]);
                                    } else if (posTag === LUA_TNUMFLT) {
                                        let vf = stack.valsF64[ra + 2];
                                        if (Number.isInteger(vf)) pos = vf;
                                        else valid = false;
                                    } else {
                                        valid = false;
                                    }
                                }
                                if (valid && pos >= 1 && pos <= u8.length) {
                                    stack.setInteger(ra, BigInt(u8[pos - 1]));
                                    ldo.adjust_top(L, ci.top);
                                    break;
                                }
                            }
                        }
                    } else if (fn && fn._is_str_sub && (b === 3 || b === 4) && nresults === 1) {
                        let sTag = stack.tags[ra + 1];
                        if (sTag === LUA_TSHRSTR || sTag === LUA_TLNGSTR) {
                            let ts = stack.refs[ra + 1] || (L.stack[ra + 1] && L.stack[ra + 1].value);
                            if (ts && ts.realstring) {
                                let u8 = ts.realstring;
                                let start = 0, end = 0, valid = true;
                                let startTag = stack.tags[ra + 2];
                                if (startTag === LUA_TNUMINT) start = Number(stack.valsI64[ra + 2]);
                                else if (startTag === LUA_TNUMFLT && Number.isInteger(stack.valsF64[ra + 2])) start = stack.valsF64[ra + 2];
                                else valid = false;

                                if (b === 4) {
                                    let endTag = stack.tags[ra + 3];
                                    if (endTag === LUA_TNUMINT) end = Number(stack.valsI64[ra + 3]);
                                    else if (endTag === LUA_TNUMFLT && Number.isInteger(stack.valsF64[ra + 3])) end = stack.valsF64[ra + 3];
                                    else valid = false;
                                } else {
                                    end = u8.length;
                                }

                                if (valid && start >= 1 && end <= u8.length && start <= end + 1) {
                                    if (start <= end) {
                                        let sub = u8.subarray(start - 1, end);
                                        let subTs = luaS_new(L, sub);
                                        stack.setObject(ra, LUA_TLNGSTR, subTs);
                                    } else {
                                        stack.setObject(ra, LUA_TLNGSTR, luaS_new(L, empty_u8));
                                    }
                                    ldo.adjust_top(L, ci.top);
                                    break;
                                }
                            }
                        }
                    }

                    if (b !== 0) ldo.adjust_top(L, ra+b);  /* else previous instruction set top */
                    cfs.saveCursor(base, ci.top, pc);
                    if (ldo.luaD_precall(L, ra, nresults)) {
                        if (nresults >= 0)
                            ldo.adjust_top(L, ci.top);  /* adjust results */
                        if (nresults > 0) {
                            stack.syncRange(ra, ra + nresults);
                        } else if (nresults < 0) {
                            stack.syncRange(ra, L.top);
                        }
                    } else {
                        ci = L.ci;
                        continue newframe;
                    }

                    break;
                }
                case OP_TAILCALL: {
                    let b = i.B;
                    if (b !== 0) ldo.adjust_top(L, ra+b);  /* else previous instruction set top */
                    /* A yield or error inside the call resumes at the following RETURN. */
                    cfs.saveCursor(base, ci.top, pc);
                    if (ldo.luaD_precall(L, ra, LUA_MULTRET)) { // JS function
                    /* Results sit at ra. The next opcode returns them. */
                        base = ci.l_base;
                    } else {
                    /* tail call: put called frame (n) in place of caller one (o) */
                        let nci = L.ci;
                        let oci = nci.previous;
                        let nfunc = nci.func;
                        let nfuncOff = nci.funcOff;
                        let ofuncOff = oci.funcOff;
                        let lim = nci.l_base + nfunc.value.p.numparams;
                        if (cl.p.p.length > 0) lfunc.luaF_close(L, oci.l_base);
                        for (let aux = 0; nfuncOff + aux < lim; aux++)
                            lobject.setobjs2s(L, ofuncOff + aux, nfuncOff + aux);
                        oci.l_base = ofuncOff + (nci.l_base - nfuncOff);
                        oci.top = ofuncOff + (L.top - nfuncOff);
                        ldo.adjust_top(L, oci.top);  /* correct top */
                        oci.l_code = nci.l_code;
                        oci.l_savedpc = nci.l_savedpc;
                        oci.func = L.stack.getTValue(ofuncOff);
                        oci.callstatus |= lstate.CIST_TAIL;
                        oci.next = null;
                        ci = L.ci = oci;
                        if (L.cfs) {
                            L.cfs.ptr = oci.cfs_ptr;
                            L.cfs.push(ofuncOff, oci.l_base, oci.top, 0, oci.nresults, oci.callstatus, nfunc.value);
                        }

                        lua_assert(L.top === oci.l_base + L.stack.getTValue(ofuncOff).value.p.maxstacksize);

                        continue newframe;
                    }
                    break;
                }
                case OP_RETURN: {
                    if (cl.p.p.length > 0) lfunc.luaF_close(L, base);
                    let b = ldo.luaD_poscall(L, ci, ra, (i.B !== 0 ? i.B - 1 : L.top - ra));

                    if (ci.callstatus & lstate.CIST_FRESH)
                        return; /* external invocation: return */
                    /* invocation via reentry: continue execution */
                    ci = L.ci;
                    if (b) L.top = ci.top;
                    lua_assert(ci.callstatus & lstate.CIST_LUA);
                    lua_assert(ci.l_code[ci.l_savedpc - 1].opcode === OP_CALL);
                    continue newframe;
                }
                case OP_FORLOOP: {
                    if (stack.tags[ra] === LUA_TNUMINT) {
                        const step = stack.valsI64[ra + 2];
                        const idx = BigInt.asIntN(64, stack.valsI64[ra] + step);
                        const limit = stack.valsI64[ra + 1];

                        if (0n < step ? idx <= limit : limit <= idx) {
                            pc += i.sBx;
                            stack.valsI64[ra] = idx;
                            stack.valsI64[ra + 3] = idx;
                            stack.tags[ra + 3] = LUA_TNUMINT;
                            stack.refs[ra] = null;
                            stack.refs[ra + 3] = null;
                            stack.dropView(ra);
                            stack.dropView(ra + 3);
                        }
                    } else {
                        const step = stack.valsF64[ra + 2];
                        const idx = stack.valsF64[ra] + step;
                        const limit = stack.valsF64[ra + 1];

                        if (0 < step ? idx <= limit : limit <= idx) {
                            pc += i.sBx;
                            stack.valsF64[ra] = idx;
                            stack.valsF64[ra + 3] = idx;
                            stack.tags[ra + 3] = LUA_TNUMFLT;
                            stack.refs[ra] = null;
                            stack.refs[ra + 3] = null;
                            stack.dropView(ra);
                            stack.dropView(ra + 3);
                        }
                    }
                    break;
                }
                case OP_FORPREP: {
                    let init = L.stack.getTValue ? L.stack.getTValue(ra) : L.stack[ra];
                    let plimit = L.stack.getTValue ? L.stack.getTValue(ra + 1) : L.stack[ra + 1];
                    let pstep = L.stack.getTValue ? L.stack.getTValue(ra + 2) : L.stack[ra + 2];
                    let forlim;

                    if (init.ttisinteger() && pstep.ttisinteger() && (forlim = forlimit(plimit, pstep.value))) {
                    /* all values are integer */
                        let initv = forlim.stopnow ? 0n : (typeof init.value === "bigint" ? init.value : BigInt(init.value));
                        let stepv = typeof pstep.value === "bigint" ? pstep.value : BigInt(pstep.value);
                        stack.setInteger(ra + 1, forlim.ilimit);
                        stack.setInteger(ra, BigInt.asIntN(64, initv - stepv));
                    } else { /* try making all values floats */
                        let nlimit, nstep, ninit;
                        if ((nlimit = tonumber(plimit)) === false)
                            ldebug.luaG_runerror(L, to_luastring("'for' limit must be a number", true));
                        stack.setNumber(ra + 1, Number(nlimit));
                        if ((nstep = tonumber(pstep)) === false)
                            ldebug.luaG_runerror(L, to_luastring("'for' step must be a number", true));
                        stack.setNumber(ra + 2, Number(nstep));
                        if ((ninit = tonumber(init)) === false)
                            ldebug.luaG_runerror(L, to_luastring("'for' initial value must be a number", true));
                        stack.setNumber(ra, Number(ninit) - Number(nstep));
                    }

                    pc += i.sBx;
                    break;
                }
                case OP_TFORCALL: {
                    let cb = ra + 3; /* call base */
                    lobject.setobjs2s(L, cb+2, ra+2);
                    lobject.setobjs2s(L, cb+1, ra+1);
                    lobject.setobjs2s(L, cb, ra);
                    ldo.adjust_top(L, cb+3);  /* func. + 2 args (state and index) */
                    ldo.luaD_call(L, cb, i.C);
                    ldo.adjust_top(L, ci.top);
                    /* go straight to OP_TFORLOOP */
                    i = code[pc++];
                    ra = RA(L, base, i);
                    lua_assert(i.opcode === OP_TFORLOOP);
                }
                /* fall through */
                case OP_TFORLOOP: {
                    if (!stack.getTValue(ra + 1).ttisnil()) { /* continue loop? */
                        lobject.setobjs2s(L, ra, ra + 1); /* save control variable */
                        pc += i.sBx; /* jump back */
                    }
                    break;
                }
                case OP_SETLIST: {
                    let n = i.B;
                    let c = i.C;

                    if (n === 0) n = L.top - ra - 1;

                    if (c === 0) {
                        lua_assert(code[pc].opcode === OP_EXTRAARG);
                        c = code[pc++].Ax;
                    }

                    let h = stack.refs[ra] || stack.getTValue(ra).value;
                    let first = ((c - 1) * LFIELDS_PER_FLUSH) + 1;

                    ltable.luaH_setlist_from_stack(L, h, first, n, stack, ra + 1);
                    ltable.invalidateTMcache(h);
                    ldo.adjust_top(L, ci.top);  /* correct top (in case of previous open call) */
                    break;
                }
                case OP_CLOSURE: {
                    let p = cl.p.p[i.Bx];
                    let ncl = getcached(L, p, cl.upvals, base);  /* cached closure */
                    if (ncl === null)  /* no match? */
                        pushclosure(L, p, cl.upvals, base, ra);  /* create a new one */
                    else
                        stack.setObject(ra, LUA_TLCL, ncl);
                    break;
                }
                case OP_VARARG: {
                    let b = i.B - 1;
                    let n = base - ci.funcOff - cl.p.numparams - 1;
                    let j;

                    if (n < 0) /* less arguments than parameters? */
                        n = 0; /* no vararg arguments */

                    if (b < 0) {
                        b = n;  /* get all var. arguments */
                        ldo.luaD_checkstack(L, n);
                        ldo.adjust_top(L, ra + n);
                    }

                    for (j = 0; j < b && j < n; j++) {
                        lobject.setobjs2s(L, ra + j, base - n + j);
                        stack.syncFromTValue(ra + j);
                    }

                    for (; j < b; j++) {
                        stack.setNil(ra + j);
                    }
                    break;
                }
                case OP_EXTRAARG: {
                    throw Error("invalid opcode");
                }
            }
        }
    }
};

const donextjump = function(L, ci, pc, code) {
    let i = code[pc];
    let a = i.A;
    if (a !== 0) lfunc.luaF_close(L, ci.l_base + a - 1);
    return pc + i.sBx + 1;
};


const luaV_lessthan = function(L, l, r) {
    if (l.ttisnumber() && r.ttisnumber())
        return LTnum(l, r) ? 1 : 0;
    else if (l.ttisstring() && r.ttisstring())
        return l_strcmp(l.tsvalue(), r.tsvalue()) < 0 ? 1 : 0;
    else {
        let res = ltm.luaT_callorderTM(L, l, r, ltm.TMS.TM_LT);
        if (res === null)
            ldebug.luaG_ordererror(L, l, r);
        return res ? 1 : 0;
    }
};

const luaV_lessequal = function(L, l, r) {
    let res;

    if (l.ttisnumber() && r.ttisnumber())
        return LEnum(l, r) ? 1 : 0;
    else if (l.ttisstring() && r.ttisstring())
        return l_strcmp(l.tsvalue(), r.tsvalue()) <= 0 ? 1 : 0;
    else {
        res = ltm.luaT_callorderTM(L, l, r, ltm.TMS.TM_LE);
        if (res !== null)
            return res ? 1 : 0;
    }
    /* try 'lt': */
    L.ci.callstatus |= lstate.CIST_LEQ; /* mark it is doing 'lt' for 'le' */
    res = ltm.luaT_callorderTM(L, r, l, ltm.TMS.TM_LT);
    L.ci.callstatus ^= lstate.CIST_LEQ; /* clear mark */
    if (res === null)
        ldebug.luaG_ordererror(L, l, r);
    return res ? 0 : 1; /* result is negated */
};

const luaV_equalobj = function(L, t1, t2) {
    if (t1.ttype() !== t2.ttype()) { /* not the same variant? */
        if (t1.ttnov() !== t2.ttnov())
            return 0;
        if (t1.ttnov() === LUA_TNUMBER) {
            return (t1.value == t2.value) ? 1 : 0;
        } else if (t1.ttnov() === LUA_TSTRING) {
            return luaS_eqlngstr(t1.tsvalue(), t2.tsvalue()) ? 1 : 0;
        }
        return 0;
    }

    let tm;

    /* values have same type and same variant */
    switch(t1.ttype()) {
        case LUA_TNIL:
            return 1;
        case LUA_TBOOLEAN:
            return t1.value == t2.value ? 1 : 0; // Might be 1 or true
        case LUA_TLIGHTUSERDATA:
        case LUA_TNUMINT:
        case LUA_TNUMFLT:
        case LUA_TLCF:
            return t1.value === t2.value ? 1 : 0;
        case LUA_TSHRSTR:
        case LUA_TLNGSTR: {
            return luaS_eqlngstr(t1.tsvalue(), t2.tsvalue()) ? 1 : 0;
        }
        case LUA_TUSERDATA:
        case LUA_TTABLE:
            if (t1.value === t2.value) return 1;
            else if (L === null) return 0;

            tm = ltm.fasttm(L, t1.value.metatable, ltm.TMS.TM_EQ);
            if (tm === null)
                tm = ltm.fasttm(L, t2.value.metatable, ltm.TMS.TM_EQ);
            break;
        default:
            return t1.value === t2.value ? 1 : 0;
    }

    if (tm === null) /* no TM? */
        return 0;

    let tv = new lobject.TValue(); /* doesn't use the stack */
    ltm.luaT_callTM(L, tm, t1, t2, tv, 1);
    return tv.l_isfalse() ? 0 : 1;
};

const luaV_rawequalobj = function(t1, t2) {
    return luaV_equalobj(null, t1, t2);
};

const forlimit = function(obj, step) {
    let stopnow = false;
    let bstep = typeof step === "bigint" ? step : BigInt(step);
    let ilimit = luaV_tointeger(obj, bstep < 0n ? 2 : 1);
    if (ilimit === false) {
        let n = tonumber(obj);
        if (n === false)
            return false;

        if (0 < n) {
            ilimit = LUA_MAXINTEGER;
            if (bstep < 0n) stopnow = true;
        } else {
            ilimit = LUA_MININTEGER;
            if (bstep >= 0n) stopnow = true;
        }
    }

    return {
        stopnow: stopnow,
        ilimit: ilimit
    };
};

/*
** try to convert a value to an integer, rounding according to 'mode':
** mode === 0: accepts only integral values
** mode === 1: takes the floor of the number
** mode === 2: takes the ceil of the number
*/
const luaV_tointeger = function(obj, mode) {
    if (obj.ttisfloat()) {
        let n = obj.value;
        let f = Math.floor(n);

        if (n !== f) { /* not an integral value? */
            if (mode === 0)
                return false;  /* fails if mode demands integral value */
            else if (mode > 1)  /* needs ceil? */
                f += 1;  /* convert floor to ceil (remember: n !== f) */
        }

        return lua_numbertointeger(f);
    } else if (obj.ttisinteger()) {
        return typeof obj.value === "bigint" ? obj.value : BigInt(obj.value);
    } else if (cvt2num(obj)) {
        let v = new lobject.TValue();
        if (lobject.luaO_str2num(obj.svalue(), v) === (obj.vslen() + 1))
            return luaV_tointeger(v, mode);
    }

    return false;
};

const tointeger = function(o) {
    return o.ttisinteger() ? (typeof o.value === "bigint" ? o.value : BigInt(o.value)) : luaV_tointeger(o, 0);
};

const tonumber = function(o) {
    if (o.ttisinteger())
        return Number(o.value);
    if (o.ttisfloat())
        return o.value;

    if (cvt2num(o)) {  /* string convertible to number? */
        let v = new lobject.TValue();
        if (lobject.luaO_str2num(o.svalue(), v) === (o.vslen() + 1))
            return v.ttisinteger() ? Number(v.value) : v.value;
    }

    return false;
};

/*
** Return 'l < r', for numbers.
** As fengari uses javascript numbers for both floats and integers and has
** correct semantics, we can just compare values.
*/
const LTnum = function(l, r) {
    return l.value < r.value;
};

/*
** Return 'l <= r', for numbers.
*/
const LEnum = function(l, r) {
    return l.value <= r.value;
};

/*
** Compare two strings 'ls' x 'rs', returning an integer smaller-equal-
** -larger than zero if 'ls' is smaller-equal-larger than 'rs'.
*/
const l_strcmp = function(ls, rs) {
    let l = luaS_hashlongstr(ls);
    let r = luaS_hashlongstr(rs);
    /* In fengari we assume string hash has same collation as byte values */
    if (l === r)
        return 0;
    else if (l < r)
        return -1;
    else
        return 1;
};

/*
** Main operation 'ra' = #rb'.
*/
const luaV_objlen = function(L, ra, rb) {
    let tm;
    switch(rb.ttype()) {
        case LUA_TTABLE: {
            let h = rb.value;
            tm = ltm.fasttm(L, h.metatable, ltm.TMS.TM_LEN);
            if (tm !== null) break; /* metamethod? break switch to call it */
            ra.setivalue(ltable.luaH_getn(h)); /* else primitive len */
            return;
        }
        case LUA_TSHRSTR:
        case LUA_TLNGSTR:
            ra.setivalue(rb.vslen());
            return;
        default: {
            tm = ltm.luaT_gettmbyobj(L, rb, ltm.TMS.TM_LEN);
            if (tm.ttisnil())
                ldebug.luaG_typeerror(L, rb, to_luastring("get length of", true));
            break;
        }
    }

    ltm.luaT_callTM(L, tm, rb, rb, ra, 1);
};

/* Shim taken from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/imul */
const luaV_imul = Math.imul || function(a, b) {
    let aHi = (a >>> 16) & 0xffff;
    let aLo = a & 0xffff;
    let bHi = (b >>> 16) & 0xffff;
    let bLo = b & 0xffff;
    /*
    ** the shift by 0 fixes the sign on the high part
    ** the final |0 converts the unsigned value into a signed value
    */
    return ((aLo * bLo) + (((aHi * bLo + aLo * bHi) << 16) >>> 0) | 0);
};

const luaV_div = function(L, m, n) {
    let bm = typeof m === "bigint" ? m : BigInt(m);
    let bn = typeof n === "bigint" ? n : BigInt(n);
    if (bn === 0n)
        ldebug.luaG_runerror(L, to_luastring("attempt to divide by zero"));
    if (bm === LUA_MININTEGER && bn === -1n)
        return LUA_MININTEGER;
    let q = bm / bn;
    let r = bm % bn;
    if ((r !== 0n) && ((r < 0n) !== (bn < 0n))) {
        q -= 1n;
    }
    return BigInt.asIntN(64, q);
};

// % semantic on negative numbers is different in js
const luaV_mod = function(L, m, n) {
    let bm = typeof m === "bigint" ? m : BigInt(m);
    let bn = typeof n === "bigint" ? n : BigInt(n);
    if (bn === 0n)
        ldebug.luaG_runerror(L, to_luastring("attempt to perform 'n%%0'"));
    if (bm === LUA_MININTEGER && bn === -1n)
        return 0n;
    let r = bm % bn;
    if ((r !== 0n) && ((r < 0n) !== (bn < 0n))) {
        r += bn;
    }
    return BigInt.asIntN(64, r);
};

const NBITS = 64n;

const luaV_shiftl = function(x, y) {
    let bx = typeof x === "bigint" ? x : BigInt(x);
    let by = typeof y === "bigint" ? y : BigInt(y);
    if (by < 0n) {  /* shift right? */
        if (by <= -NBITS || by <= -64n) return 0n;
        let u = BigInt.asUintN(64, bx);
        return BigInt.asIntN(64, u >> (-by));
    }
    else {  /* shift left */
        if (by >= NBITS || by >= 64n) return 0n;
        return BigInt.asIntN(64, bx << by);
    }
};

/*
** check whether cached closure in prototype 'p' may be reused, that is,
** whether there is a cached closure with the same upvalues needed by
** new closure to be created.
*/
const getcached = function(L, p, encup, base) {
    let c = p.cache;
    if (c !== null) {  /* is there a cached closure? */
        let uv = p.upvalues;
        let nup = uv.length;
        for (let i = 0; i < nup; i++) {  /* check whether it has right upvalues */
            let v = uv[i].instack ? lfunc.luaF_findupval(L, base + uv[i].idx) : encup[uv[i].idx];
            if (c.upvals[i] !== v)
                return null;  /* wrong upvalue; cannot reuse closure */
        }
    }
    return c;  /* return cached closure (or NULL if no cached closure) */
};

/*
** create a new Lua closure, push it in the stack, and initialize
** its upvalues.
*/
const pushclosure = function(L, p, encup, base, ra) {
    let nup = p.upvalues.length;
    let uv = p.upvalues;
    let ncl = new lobject.LClosure(L, nup);
    ncl.p = p;
    L.stack.setObject(ra, LUA_TLCL, ncl);
    for (let i = 0; i < nup; i++) {
        if (uv[i].instack)
            ncl.upvals[i] = lfunc.luaF_findupval(L, base + uv[i].idx);
        else
            ncl.upvals[i] = encup[uv[i].idx];
    }
    p.cache = ncl;  /* save it on cache for reuse */
};

const cvt2str = function(o) {
    return o.ttisnumber();
};

const cvt2num = function(o) {
    return o.ttisstring();
};

const tostring = function(L, i) {
    let o = L.stack.getTValue ? L.stack.getTValue(i) : L.stack[i];

    if (o.ttisstring()) return true;

    if (cvt2str(o)) {
        lobject.luaO_tostring(L, o);
        if (L.stack && L.stack.syncFromTValue)
            L.stack.syncFromTValue(i);
        return true;
    }

    return false;
};

const isemptystr = function(o) {
    return o.ttisstring() && o.vslen() === 0;
};

/* copy strings in stack from top - n up to top - 1 to buffer */
const copy2buff = function(L, top, n, buff) {
    let tl = 0;  /* size already copied */
    do {
        let tv = L.stack.getTValue ? L.stack.getTValue(top - n) : L.stack[top - n];
        let l = tv.vslen();  /* length of string being copied */
        let s = tv.svalue();
        buff.set(s, tl);
        tl += l;
    } while (--n > 0);
};

/*
** Main operation for concatenation: concat 'total' values in the stack,
** from 'L->top - total' up to 'L->top - 1'.
*/
const luaV_concat = function(L, total) {
    lua_assert(total >= 2);
    do {
        let top = L.top;
        let n = 2; /* number of elements handled in this pass (at least 2) */

        let left = L.stack.getTValue(top - 2);
        let right = L.stack.getTValue(top - 1);
        if (!(left.ttisstring() || cvt2str(left)) || !tostring(L, top - 1)) {
            ltm.luaT_trybinTM(L, left, right, left, ltm.TMS.TM_CONCAT);
            if (L.stack && L.stack.syncFromTValue)
                L.stack.syncFromTValue(top - 2);
        } else if (isemptystr(right)) {
            tostring(L, top - 2);
        } else if (isemptystr(left)) {
            lobject.setobjs2s(L, top - 2, top - 1);
        } else {
            /* at least two non-empty string values; get as many as possible */
            let tl = L.stack.getTValue(top - 1).vslen();
            /* collect total length and number of strings */
            for (n = 1; n < total && tostring(L, top - n - 1); n++) {
                let l = L.stack.getTValue(top - n - 1).vslen();
                tl += l;
            }
            let buff = new Uint8Array(tl);
            copy2buff(L, top, n, buff);
            let ts = luaS_bless(L, buff);
            lobject.setsvalue2s(L, top - n, ts);
        }
        total -= n - 1; /* got 'n' strings to create 1 new */
        /* popped 'n' strings and pushed one */
        L.top = top - (n - 1);
    } while (total > 1); /* repeat until only 1 result left */
};

const MAXTAGLOOP = 2000;

const luaV_gettable = function(L, t, key, ra) {
    for (let loop = 0; loop < MAXTAGLOOP; loop++) {
        let tm;

        if (!t.ttistable()) {
            tm = ltm.luaT_gettmbyobj(L, t, ltm.TMS.TM_INDEX);
            if (tm.ttisnil())
                ldebug.luaG_typeerror(L, t, to_luastring('index', true)); /* no metamethod */
            /* else will try the metamethod */
        } else {
            let slot = ltable.luaH_get(L, t.value, key);
            if (!slot.ttisnil()) {
                lobject.setobj2s(L, ra, slot);
                return;
            } else { /* 't' is a table */
                tm = ltm.fasttm(L, t.value.metatable, ltm.TMS.TM_INDEX);  /* table's metamethod */
                if (tm === null) { /* no metamethod? */
                    if (L.stack.setNil)
                        L.stack.setNil(ra);
                    else
                        L.stack[ra].setnilvalue(); /* result is nil */
                    return;
                }
            }
            /* else will try the metamethod */
        }
        if (tm.ttisfunction()) { /* is metamethod a function? */
            ltm.luaT_callTM(L, tm, t, key, L.stack[ra], 1); /* call it */
            if (L.stack && L.stack.syncFromTValue)
                L.stack.syncFromTValue(ra);
            return;
        }
        t = tm;  /* else try to access 'tm[key]' */
    }

    ldebug.luaG_runerror(L, to_luastring("'__index' chain too long; possible loop", true));
};

const settable = function(L, t, key, val) {
    for (let loop = 0; loop < MAXTAGLOOP; loop++) {
        let tm;
        if (t.ttistable()) {
            let h = t.value; /* save 't' table */
            let slot = ltable.luaH_get(L, h, key);
            if (!slot.ttisnil() || (tm = ltm.fasttm(L, h.metatable, ltm.TMS.TM_NEWINDEX)) === null) {
                ltable.luaH_setfrom(L, h, key, val);
                ltable.invalidateTMcache(h);
                return;
            }
            /* else will try the metamethod */
        } else { /* not a table; check metamethod */
            if ((tm = ltm.luaT_gettmbyobj(L, t, ltm.TMS.TM_NEWINDEX)).ttisnil())
                ldebug.luaG_typeerror(L, t, to_luastring('index', true));
        }
        /* try the metamethod */
        if (tm.ttisfunction()) {
            ltm.luaT_callTM(L, tm, t, key, val, 0);
            return;
        }
        t = tm;  /* else repeat assignment over 'tm' */
    }

    ldebug.luaG_runerror(L, to_luastring("'__newindex' chain too long; possible loop", true));
};


module.exports.cvt2str          = cvt2str;
module.exports.cvt2num          = cvt2num;
module.exports.luaV_gettable    = luaV_gettable;
module.exports.luaV_concat      = luaV_concat;
module.exports.luaV_div         = luaV_div;
module.exports.luaV_equalobj    = luaV_equalobj;
module.exports.luaV_execute     = luaV_execute;
module.exports.luaV_finishOp    = luaV_finishOp;
module.exports.luaV_imul        = luaV_imul;
module.exports.luaV_lessequal   = luaV_lessequal;
module.exports.luaV_lessthan    = luaV_lessthan;
module.exports.luaV_mod         = luaV_mod;
module.exports.luaV_objlen      = luaV_objlen;
module.exports.luaV_rawequalobj = luaV_rawequalobj;
module.exports.luaV_shiftl      = luaV_shiftl;
module.exports.luaV_tointeger   = luaV_tointeger;
module.exports.settable         = settable;
module.exports.tointeger        = tointeger;
module.exports.tonumber         = tonumber;
