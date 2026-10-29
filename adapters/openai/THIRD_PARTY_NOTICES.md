# Third-party notices

ModelDock's original source is MIT licensed. Each dependency retains its license.
All runtime files are bundled locally; viewing does not require a CDN or a cloud conversion service.

## CAD kernel

**occt-import-js 0.0.23** is distributed under LGPL-2.1 and includes an OpenCascade Technology 7.6.1 WebAssembly build.
The WebAssembly is unmodified. The JavaScript glue has a hash-guarded patch using static Emscripten invoker closures so it runs without JavaScript unsafe-eval; see scripts/patch-occt.mjs and docs/cad-source.md. Both remain replaceable components. Complete LGPL and OCCT exception texts are in dist/licenses/ (or licenses/ in native adapter packages).
Wrapper source: https://github.com/kovacsv/occt-import-js/tree/c2148e54b456b571238d35cac037d304053d64b2 .
OpenCascade source: https://github.com/Open-Cascade-SAS/OCCT/tree/d2abb6d844231cb8f29be6894440874a4700e4a5 .
The complete source release includes matching unmodified archives in third_party/cad-source/. See docs/cad-source.md for checksums, source lineage and rebuild steps using Emscripten 3.1.69.
You may replace dist/web/occt-import-js.js and dist/web/occt-import-js.wasm, or rebuild all embedded adapters with npm run build.
The MIT license of the surrounding application does not relicense the CAD kernel. Distribute the corresponding source package alongside binary releases.

## Runtime dependency inventory

| Package | Version | License |
| --- | --- | --- |
| @cfworker/json-schema | 4.1.1 | MIT |
| @hono/node-server | 2.1.5 | MIT |
| @modelcontextprotocol/core | 2.4.0 | Apache-2.0 |
| @modelcontextprotocol/ext-apps | 1.7.5 | MIT |
| @modelcontextprotocol/sdk | 1.32.2 | MIT |
| @modelcontextprotocol/server | 2.4.0 | Apache-2.0 |
| @openai/mcp-extensions | 0.2.1 | Apache-2.0 |
| @standard-schema/spec | 1.1.0 | MIT |
| accepts | 2.0.0 | MIT |
| ajv | 8.20.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| body-parser | 2.4.0 | MIT |
| bytes | 3.1.2 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| content-disposition | 2.0.1 | MIT |
| content-type | 1.0.5 | MIT |
| content-type | 2.1.0 | MIT |
| cookie | 0.7.2 | MIT |
| cookie-signature | 1.2.2 | MIT |
| cors | 2.8.6 | MIT |
| cross-spawn | 7.0.6 | MIT |
| debug | 4.4.3 | MIT |
| depd | 2.0.0 | MIT |
| dunder-proto | 1.0.1 | MIT |
| ee-first | 1.1.1 | MIT |
| encodeurl | 2.0.1 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| escape-html | 1.0.3 | MIT |
| etag | 1.8.1 | MIT |
| eventsource | 3.0.7 | MIT |
| eventsource-parser | 3.1.1 | MIT |
| express | 5.3.0 | MIT |
| express-rate-limit | 8.7.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-uri | 3.1.9 | BSD-3-Clause |
| finalhandler | 2.1.1 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 2.0.0 | MIT |
| function-bind | 1.1.2 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| gopd | 1.2.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| hasown | 2.0.4 | MIT |
| hono | 4.13.14 | MIT |
| http-errors | 2.0.1 | MIT |
| iconv-lite | 0.7.3 | MIT |
| inherits | 2.0.4 | ISC |
| ip-address | 10.7.5 | MIT |
| ipaddr.js | 1.9.1 | MIT |
| is-promise | 4.0.0 | MIT |
| isexe | 2.0.0 | ISC |
| jose | 6.2.13 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| json-schema-typed | 8.0.2 | BSD-2-Clause |
| math-intrinsics | 1.1.0 | MIT |
| media-typer | 1.1.1 | MIT |
| merge-descriptors | 2.0.0 | MIT |
| mime-db | 1.54.0 | MIT |
| mime-types | 3.0.2 | MIT |
| ms | 2.1.3 | MIT |
| negotiator | 1.1.0 | MIT |
| object-assign | 4.1.1 | MIT |
| object-inspect | 1.13.4 | MIT |
| occt-import-js | 0.0.23 | LGPL-2.1 |
| on-finished | 2.4.2 | MIT |
| once | 1.4.0 | ISC |
| parseurl | 1.3.3 | MIT |
| path-key | 3.1.1 | MIT |
| path-to-regexp | 8.4.2 | MIT |
| pkce-challenge | 5.0.1 | MIT |
| proxy-addr | 2.0.8 | MIT |
| qs | 6.17.1 | BSD-3-Clause |
| range-parser | 1.3.0 | MIT |
| raw-body | 3.0.2 | MIT |
| react | 19.3.1 | MIT |
| require-from-string | 2.0.2 | MIT |
| router | 2.2.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| send | 1.2.1 | MIT |
| serve-static | 2.2.1 | MIT |
| setprototypeof | 1.2.0 | ISC |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| side-channel | 1.1.1 | MIT |
| side-channel-list | 1.0.1 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| statuses | 2.0.2 | MIT |
| three | 0.186.1 | MIT |
| toidentifier | 1.0.1 | MIT |
| type-is | 2.1.0 | MIT |
| unpipe | 1.0.0 | MIT |
| vary | 1.1.2 | MIT |
| which | 2.0.2 | ISC |
| wrappy | 1.0.2 | ISC |
| zod | 4.6.7 | MIT |
| zod-to-json-schema | 3.25.2 | ISC |

Full available license and notice texts are shipped in dist/licenses/. Build and test tooling is listed in package-lock.json.
React in the DeepSeek Harness adapter is provided by the host and is not copied into the adapter.
