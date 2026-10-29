#!/usr/bin/env node
/**
 * ModelDock CAD CSP compatibility patch, 2026-10-29.
 *
 * The occt-import-js 0.0.23 Emscripten glue generates JavaScript functions at
 * runtime. Replace its three known dynamic-code paths with static closures,
 * following Emscripten 3.1.69's DYNAMIC_EXECUTION=0 implementations:
 *   src/embind/embind.js ($craftInvokerFunction)
 *   src/embind/emval.js (_emval_get_method_caller, $emval_get_global)
 * Emscripten copyright/license: third_party/licenses/emscripten-3.1.69-LICENSE.
 * Full upstream reference sources: third_party/cad-source/emscripten-3.1.69/.
 * The resulting modified loader retains occt-import-js's LGPL-2.1 license.
 * The WASM is not changed. Input package files are never written by this tool.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const OCCT_ORIGINAL_SHA256 = '3fb44ce11d00611f9b3f3c5775d520ebab48930c1f08279b7b1316f05f0d3379';
export const OCCT_CSP_PATCH_VERSION = 'modeldock-csp-1';
const sha256 = text => createHash('sha256').update(text).digest('hex');

function replaceRange(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || source.indexOf(startMarker, start + startMarker.length) !== -1) {
    throw new Error(`CAD patch expected one exact region beginning ${startMarker}`);
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

// Static JS -> C++ marshaling. Per-invocation arrays also permit reentrant calls.
// This package has neither Asyncify nor JSPI enabled, matching the original glue.
const staticInvoker = `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){
  var argCount=argTypes.length;
  if(argCount<2)throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!");
  var isClassMethodFunc=argTypes[1]!==null&&classType!==null;
  var needsDestructorStack=usesDestructorStack(argTypes);
  var returns=argTypes[0].name!=="void";
  var expectedArgCount=argCount-2;
  var invokerFn=function(...args){
    var argsWired=new Array(expectedArgCount);
    var destructors=needsDestructorStack?[]:null;
    var invokerFuncArgs=[cppTargetFunc];
    var thisWired;
    if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);invokerFuncArgs.push(thisWired);}
    for(var i=0;i<expectedArgCount;++i){argsWired[i]=argTypes[i+2].toWireType(destructors,args[i]);invokerFuncArgs.push(argsWired[i]);}
    var rv=cppInvokerFunc(...invokerFuncArgs);
    if(needsDestructorStack){runDestructors(destructors);}
    else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var param=i===1?thisWired:argsWired[i-2];if(argTypes[i].destructorFunction!==null)argTypes[i].destructorFunction(param);}}
    if(returns)return argTypes[0].fromWireType(rv);
  };
  return createNamedFunction(humanName,invokerFn);
}
`;

// C++ -> JS calls and constructors: read packed wire arguments without creating
// or interpreting JavaScript source. Preserve the original void-return behavior.
const staticMethodCaller = `var __emval_get_method_caller=(argCount,argTypes,kind)=>{
  var types=emval_lookupTypes(argCount,argTypes);
  var retType=types.shift();argCount--;
  var invokerFunction=(obj,func,destructorsRef,args)=>{
    var argN=new Array(argCount),offset=0;
    for(var i=0;i<argCount;++i){argN[i]=types[i].readValueFromPointer(args+offset);offset+=types[i].argPackAdvance;}
    var rv=kind===1?reflectConstruct(func,argN):func.apply(obj,argN);
    if(!retType.isVoid)return emval_returnValue(retType,destructorsRef,rv);
  };
  var functionName="methodCaller<("+types.map(t=>t.name).join(", ")+") => "+retType.name+">";
  return emval_addMethodCaller(createNamedFunction(functionName,invokerFunction));
};
`;

const staticGlobal = `var emval_get_global=()=>{
  if(typeof globalThis==="object")return globalThis;
  if(typeof self==="object")return self;
  if(typeof global==="object")return global;
  throw new Error("Unable to get the global object without dynamic execution.");
};
`;

export function patchOcctSource(original) {
  const actual = sha256(original);
  if (actual !== OCCT_ORIGINAL_SHA256) {
    throw new Error(`CAD CSP patch is pinned to occt-import-js 0.0.23 (${OCCT_ORIGINAL_SHA256}); input was ${actual}. Review or replace this patch for a different/custom kernel. No files were modified.`);
  }
  let patched = replaceRange(original, 'function newFunc(', 'var ensureOverloadTable=', staticInvoker);
  patched = replaceRange(patched, 'var emval_get_global=', 'var __emval_get_global=', staticGlobal);
  patched = replaceRange(patched, 'var __emval_get_method_caller=', 'var __emval_get_property=', staticMethodCaller);
  if (/\bnewFunc\b|\bcreateJsInvoker\b|\beval\s*\(|\bnew\s+Function\b|return\s+Function\b/.test(patched)) {
    throw new Error('CAD CSP patch left a dynamic-code helper; refusing to emit output.');
  }
  return `/*! ModelDock modification 2026-10-29, ${OCCT_CSP_PATCH_VERSION}.
 * occt-import-js 0.0.23: replaced dynamic Embind/Emval function generation and
 * legacy global lookup with static closures. WASM remains unchanged.
 * LGPL-2.1 applies to this modified loader; preserve upstream notices.
 * Closure implementation follows Emscripten 3.1.69 (MIT/NCSA).
 * See docs/cad-source.md and scripts/patch-occt.mjs for source and changes.
 */\n${patched}`;
}

export async function patchOcct(input = 'node_modules/occt-import-js/dist/occt-import-js.js', output = 'dist/web/occt-import-js.js') {
  const original = await readFile(input, 'utf8');
  const patched = patchOcctSource(original);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, patched);
  return { patch: OCCT_CSP_PATCH_VERSION, inputSHA256: sha256(original), outputSHA256: sha256(patched), bytes: Buffer.byteLength(patched) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await patchOcct(process.argv[2], process.argv[3])));
}
