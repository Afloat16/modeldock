# CAD runtime: source provenance, rebuilding and replacement

ModelDock uses **occt-import-js 0.0.23**, which wraps Open CASCADE Technology
and distributes a JavaScript loader plus a WebAssembly CAD kernel. ModelDock
applies the documented static-closure patch below to the JavaScript loader; the
WASM bytes remain unchanged. These files
are separate dependencies of ModelDock's MIT-licensed integration code. Their
upstream license notices remain in effect; the application's MIT license does
not replace them.

The exact wrapper and OCCT source archives are included under
[`third_party/cad-source/`](../third_party/cad-source/), together with
[`provenance.json`](../third_party/cad-source/provenance.json) and
[`SHA256SUMS`](../third_party/cad-source/SHA256SUMS). They are unmodified upstream
archives, not a stripped collection of headers or a link to an unspecified
future branch. Their combined size is 52,618,541 bytes, approximately 50.18 MiB.

## Exact source lineage

Verified on 2026-10-29 against the installed npm package, the public npm registry,
the wrapper Git tree and the downloaded source archives.

| Item | Exact identity | Primary source |
| --- | --- | --- |
| npm package | `occt-import-js@0.0.23` | [Registry release metadata](https://registry.npmjs.org/occt-import-js/0.0.23) |
| npm `gitHead` / wrapper commit | `c2148e54b456b571238d35cac037d304053d64b2` | [Wrapper source](https://github.com/kovacsv/occt-import-js/tree/c2148e54b456b571238d35cac037d304053d64b2) |
| Wrapper commit date | `2024-12-02T18:32:19Z` | [Commit record](https://github.com/kovacsv/occt-import-js/commit/c2148e54b456b571238d35cac037d304053d64b2) |
| `occt` submodule Git link | `d2abb6d844231cb8f29be6894440874a4700e4a5` | [Wrapper Git tree API](https://api.github.com/repos/kovacsv/occt-import-js/git/trees/c2148e54b456b571238d35cac037d304053d64b2) |
| OCCT version at that commit | `7.6.1` | [Standard_Version.hxx](https://github.com/Open-Cascade-SAS/OCCT/blob/d2abb6d844231cb8f29be6894440874a4700e4a5/src/Standard/Standard_Version.hxx) |
| Compiler SDK pinned by upstream | Emscripten `3.1.69` | [Upstream setup script](https://github.com/kovacsv/occt-import-js/blob/c2148e54b456b571238d35cac037d304053d64b2/tools/setup_emscripten_win.bat) |

The wrapper's [`.gitmodules`](https://github.com/kovacsv/occt-import-js/blob/c2148e54b456b571238d35cac037d304053d64b2/.gitmodules)
names `https://git.dev.opencascade.org/repos/occt.git`. The bundled OCCT archive
was retrieved from the official
[`Open-Cascade-SAS/OCCT`](https://github.com/Open-Cascade-SAS/OCCT) repository at
that **same full commit**, rather than substituting a newer OCCT release.

The npm package integrity recorded by the registry and lockfile is:

```text
sha512-RFfYQXYFX5C1mB1Aywm0ShcUKzXOr/VzTnlzhBSDJOR6YCAPt1HYCzeXWg1vwwjn/cUxwqRNhhtf1dlewoZYCQ==
```

### What was compared

The WASM copied by ModelDock was verified byte-for-byte against the wrapper's
Git archive. Before applying ModelDock's patch, the npm JavaScript and build
scripts use CRLF line endings while the Git archive uses LF. Their text matches
after normalising only those line endings. That input-format difference is
separate from the explicit ModelDock loader modification below.

| Original npm input asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `occt-import-js.js` before patch | 96,871 | `3fb44ce11d00611f9b3f3c5775d520ebab48930c1f08279b7b1316f05f0d3379` |
| `occt-import-js.wasm` | 7,604,031 | `33391fc9d94ea5c869a6718488bf0a9a464222bac9bdc764dfe1690cef281952` |

The original package was exercised in Node and a real browser Worker with STEP,
IGES and BREP fixtures. **A full Emscripten recompilation was not run in the
delivery environment.** The build recipe below follows the pinned upstream
CMake/build scripts; it does not claim bit-for-bit reproduction of the published
binary across toolchain or operating-system differences.

## ModelDock modification: static JavaScript bindings for strict CSP

**Modification date: 2026-10-29. Patch identifier: `modeldock-csp-1`.**

The upstream Emscripten glue constructs JavaScript source at runtime in Embind
and Emval. A Content Security Policy allowing WebAssembly compilation with
`'wasm-unsafe-eval'` still blocks string-to-JavaScript compilation. ModelDock's
[`scripts/patch-occt.mjs`](../scripts/patch-occt.mjs) replaces those glue paths
with static closures. It does not add `'unsafe-eval'` to host policy or alter
the WASM.

The complete, readable patch is shipped as source and checks the exact original
npm JavaScript SHA-256 before applying its three fixed source-region changes:

1. Replace `craftInvokerFunction` with ordinary JavaScript closures for typed
   argument conversion, C++ invocation, destruction and return conversion.
   Remove the now-unused `newFunc` and `createJsInvoker` string-code helpers.
2. Replace `__emval_get_method_caller` with ordinary calls / `Reflect.construct`
   on the already-registered functions and decoded arguments.
3. Replace the legacy `Function('return this')` fallback in `emval_get_global`
   with direct `globalThis`, `self` or `global` lookup.

The implementation follows the **`DYNAMIC_EXECUTION=0` branches in Emscripten
3.1.69**, adapted to this runtime's non-Asyncify/non-JSPI configuration and its
existing void-return behavior. Per-call temporary arrays permit reentrant
marshalling. No generated source text is interpreted or evaluated.

Primary references and preserved source:

- [Emscripten setting reference](https://emscripten.org/docs/tools_reference/settings_reference.html#dynamic-execution)
- [3.1.69 `src/embind/embind.js`](https://github.com/emscripten-core/emscripten/blob/3.1.69/src/embind/embind.js),
  preserved at [`third_party/cad-source/emscripten-3.1.69/embind.js`](../third_party/cad-source/emscripten-3.1.69/embind.js)
- [3.1.69 `src/embind/emval.js`](https://github.com/emscripten-core/emscripten/blob/3.1.69/src/embind/emval.js),
  preserved at [`third_party/cad-source/emscripten-3.1.69/emval.js`](../third_party/cad-source/emscripten-3.1.69/emval.js)
- [Exact Emscripten MIT/NCSA license](../third_party/licenses/emscripten-3.1.69-LICENSE)

| ModelDock output | Bytes | SHA-256 |
| --- | ---: | --- |
| Patched `occt-import-js.js` | 95,501 | `3682a7c411a72fd6b9a13326595d4813f2c478cd387a7b24730617138a887600` |
| Unmodified `occt-import-js.wasm` | 7,604,031 | `33391fc9d94ea5c869a6718488bf0a9a464222bac9bdc764dfe1690cef281952` |

Run `node scripts/patch-occt.mjs` to regenerate the patched loader from the
unchanged dependency. The normal build invokes it before embedding assets into
adapters. The emitted loader has a prominent modification and license notice.

Verification performed:

- A real browser Worker under `script-src 'self' blob: 'wasm-unsafe-eval'`, with
  no `'unsafe-eval'`, rejects the original runtime and loads the patched runtime.
- The patched Worker successfully imports STEP, IGES and BREP cubes, a curved
  bored mounting bracket, and a repeat import in the same Worker.
- [`tests/occt-runtime.test.ts`](../tests/occt-runtime.test.ts) rejects altered
  patch inputs, rejects the original runtime in a no-string-code VM, and
  compares every decoded coordinate, normal, index, colour, name and warning
  against the original runtime for those fixtures.

## Retrieve or verify the source archives

From the ModelDock project root:

```bash
cd third_party/cad-source
sha256sum -c SHA256SUMS
```

On macOS, use `shasum -a 256 -c SHA256SUMS` if `sha256sum` is unavailable.
The unmodified archive download URLs are:

- [Wrapper source archive](https://codeload.github.com/kovacsv/occt-import-js/tar.gz/c2148e54b456b571238d35cac037d304053d64b2)
- [OCCT source archive](https://codeload.github.com/Open-Cascade-SAS/OCCT/tar.gz/d2abb6d844231cb8f29be6894440874a4700e4a5)

Archive checksums:

```text
2bd3799b2ac56cbf3f0df6300a51c8890e137bd001462702b356f621e33ff192  occt-import-js-c2148e54b456b571238d35cac037d304053d64b2.tar.gz
2715d89a1bc44dfd34dab88f729c445ea93f6b57d6539b0c89614a80ae144a6c  occt-d2abb6d844231cb8f29be6894440874a4700e4a5.tar.gz
```

## Rebuild the CAD JavaScript and WASM

You need a C/C++ build environment, Python, Git, CMake and a build tool. Use
Emscripten **3.1.69**, as pinned by the wrapper, and a CMake version supporting
`target_link_options` (3.13 or later). The first SDK installation downloads the
compiler toolchain; viewing models in the finished extension does not need it.
Compilation uses many OCCT source files and can take substantial time and RAM.

The following POSIX-shell recipe adapts the upstream Windows CMake invocation
and adds `-sDYNAMIC_EXECUTION=0` at link time to generate CSP-compatible glue
directly. Start at the ModelDock
project root. Use a separate build directory so it does not become application
source or overwrite the source archives.

```bash
modeldock_root="$PWD"
cad_build="$modeldock_root/.cad-build"
cad_source="$cad_build/occt-import-js-c2148e54b456b571238d35cac037d304053d64b2"
mkdir -p "$cad_build"

tar -xzf "$modeldock_root/third_party/cad-source/occt-import-js-c2148e54b456b571238d35cac037d304053d64b2.tar.gz" -C "$cad_build"
mkdir -p "$cad_source/occt"
tar -xzf "$modeldock_root/third_party/cad-source/occt-d2abb6d844231cb8f29be6894440874a4700e4a5.tar.gz" --strip-components=1 -C "$cad_source/occt"

git clone https://github.com/emscripten-core/emsdk.git "$cad_build/emsdk"
"$cad_build/emsdk/emsdk" install 3.1.69
"$cad_build/emsdk/emsdk" activate 3.1.69
. "$cad_build/emsdk/emsdk_env.sh"

emcmake cmake -S "$cad_source" -B "$cad_source/build/wasm" \
  -G "Unix Makefiles" -DEMSCRIPTEN=1 -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXE_LINKER_FLAGS="-sDYNAMIC_EXECUTION=0"
cmake --build "$cad_source/build/wasm" --parallel 2
```

Expected outputs are:

```text
.cad-build/occt-import-js-c2148e54b456b571238d35cac037d304053d64b2/build/wasm/Release/occt-import-js.js
.cad-build/occt-import-js-c2148e54b456b571238d35cac037d304053d64b2/build/wasm/Release/occt-import-js.wasm
```

On Windows, the source archive contains the upstream
`tools/setup_emscripten_win.bat`, `tools/build_wasm_win.bat` and
`tools/build_wasm_win_release.bat`. Their setup uses Emscripten 3.1.69 and
`mingw-7.1.0-64bit`; run them from the extracted wrapper with its `occt/` source
directory populated. The complete CMake source remains authoritative for the
module list and flags. For strict CSP, add
`target_link_options(OcctImportJS PUBLIC -sDYNAMIC_EXECUTION=0)` to that source's
`CMakeLists.txt` when using the upstream batch scripts, and record the change.

ModelDock expects the factory `occtimportjs` and the `ReadStepFile`,
`ReadIgesFile`, `ReadBrepFile` methods. Keep this interface compatible, or update
`src/core/cad.ts` and `src/core/worker.ts` together with the library.

## Use a modified or rebuilt CAD library in ModelDock

The default patch deliberately accepts only the known upstream loader; it will
not silently rewrite arbitrary custom glue. If you compile your own loader
with `-sDYNAMIC_EXECUTION=0`, change the `patchOcct(...)` step in your local
`scripts/build.mjs` to copy your already CSP-compatible JavaScript file with
`copyFile(...)`. Keep the host's CSP intact. Then replace the two build inputs
after installing the project's JavaScript dependencies and rebuild all adapters:

```bash
cd "$modeldock_root"
npm ci
cp "$cad_source/build/wasm/Release/occt-import-js.js" node_modules/occt-import-js/dist/occt-import-js.js
cp "$cad_source/build/wasm/Release/occt-import-js.wasm" node_modules/occt-import-js/dist/occt-import-js.wasm
npm run build
npm test
npm run package:vsix
```

`npm ci` restores dependencies from the lockfile, so apply your replacements
**after** that command. Subsequent `npm run build` and VSIX prepublish steps copy
the selected files from that location. Maintain modifications in your own CAD
source checkout; do not rely on edits inside `node_modules` as their only copy.

The build produces separate files at `dist/web/occt-import-js.js` and
`dist/web/occt-import-js.wasm`. The local viewer and VS Code Worker load those
files at runtime. For a quick local comparison you can replace that pair in an
existing unpacked build; a later rebuild will overwrite it from the dependency
inputs above. The DeepSeek and OpenAI adapters embed the assets in their client
bundles, so they must be rebuilt to use a replacement kernel. No runtime hash
check prevents use of an interface-compatible replacement.

If you distribute a modified library, preserve upstream notices, record your
changes and the actual source revisions, and update the recorded binary hashes
and source bundle. The separate upstream and patched hashes in this document
identify exactly the 0.0.23 inputs and `modeldock-csp-1` output described here.

## Notices shipped with the source

- Wrapper: upstream `LICENSE.md`, also included in the source archive and npm
  package; the package declares LGPL-2.1.
- OCCT: [`LICENSE_LGPL_21.txt`](../third_party/licenses/LICENSE_LGPL_21.txt), copied
  verbatim from the pinned OCCT source archive.
- OCCT: [`OCCT_LGPL_EXCEPTION.txt`](../third_party/licenses/OCCT_LGPL_EXCEPTION.txt),
  copied verbatim from the same source archive.
- Emscripten: [`emscripten-3.1.69-LICENSE`](../third_party/licenses/emscripten-3.1.69-LICENSE),
  copied verbatim with the runtime source used for the static-closure patch.

These exact OCCT files can also be retrieved from the pinned source:
[LGPL text](https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/d2abb6d844231cb8f29be6894440874a4700e4a5/LICENSE_LGPL_21.txt)
and [OCCT exception](https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/d2abb6d844231cb8f29be6894440874a4700e4a5/OCCT_LGPL_EXCEPTION.txt).

Keep the notices, source archives, provenance and rebuild instructions with the
public release. If source archives are published as a separate download to keep
the VSIX small, place that download beside the binaries in the same release and
link it from the release description.
