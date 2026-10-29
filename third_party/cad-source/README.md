# CAD dependency source archives

These are unmodified archives of the precise upstream Git commits associated
with the bundled `occt-import-js@0.0.23` runtime. They contain upstream source,
build scripts, notices and the upstream repository contents, including any
upstream examples/test data. Those contents are not ModelDock's original models
and retain their upstream notices.

| Archive | Bytes | Purpose |
| --- | ---: | --- |
| `occt-import-js-c2148e54b456b571238d35cac037d304053d64b2.tar.gz` | 4,399,573 | Wrapper source and build scripts |
| `occt-d2abb6d844231cb8f29be6894440874a4700e4a5.tar.gz` | 48,218,968 | Exact OpenCascade submodule source, version 7.6.1 |

The combined archive size is 52,618,541 bytes (about 50.18 MiB).
`SHA256SUMS` records the archive checksums; `provenance.json` records the npm
integrity, Git revisions, public retrieval URLs and distributed asset hashes.

See [CAD source and rebuild instructions](../../docs/cad-source.md) for extraction,
rebuilding and using a modified CAD runtime. Full OCCT license/exception texts
are also copied verbatim into `../licenses/`.

ModelDock's `modeldock-csp-1` JavaScript-glue modification is maintained in
`../../scripts/patch-occt.mjs`. It leaves these archives and the WASM unmodified.
The exact Emscripten 3.1.69 `DYNAMIC_EXECUTION=0` reference sources are preserved
in `emscripten-3.1.69/`; their MIT/NCSA license is at
`../licenses/emscripten-3.1.69-LICENSE`. The provenance JSON distinguishes the
upstream input hashes from the patched output hash.

Keep these source materials available with ModelDock binary releases. They may
be shipped in the source distribution or as an accompanying source-download
asset; the main application source and this document should remain accessible
alongside them.
