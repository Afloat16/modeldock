# Bounded previews for files of 5 GiB and larger

ModelDock's random-access loader accepts positive JavaScript safe-integer source
sizes; there is no 32-bit offset coercion or 128 MiB source-size limit in this
loader. The 5 GiB capability is a **sampled preview**, with a bounded geometry
allocation and bounded I/O. It does not promise to decode every format at that size.

## Format and transport limits

| Input | Large-file behavior |
| --- | --- |
| Binary PLY, little or big endian, fixed-width vertex records | Deterministic point samples across the full vertex-record index range, including the beginning and end. Float64 positions are rebased before Float32 conversion. RGB, diffuse RGB, normals and Gaussian DC colors are supported. |
| Binary PLY containing polygon faces | Vertex centres are shown as points. Face topology is explicitly unavailable, with original polygon count retained in metadata. No sampled triangle count or full surface is invented. Lists before vertices, or list-valued vertex records, require an external index and are rejected. |
| Binary STL | Deterministic samples of full triangle records across the source. Strictly checks `84 + 50 × triangleCount` against file size. STL's uint32 triangle declaration supports files larger than 5 GiB; trailing bytes are rejected. |
| ASCII PLY/STL, OBJ, OFF, XYZ, PCD, glTF/GLB | The large-file path rejects these with conversion guidance. They require streaming/indexing work or the existing bounded in-memory path for smaller inputs. |
| STEP, IGES, BREP and other CAD | Full 5 GiB tessellation is **not supported** by the browser's in-memory OCCT/WASM decoder. Use an external out-of-core converter to binary PLY/STL, with appropriate mesh decimation. |
| Browser `File`/`Blob` | Uses `slice(offset, offset + length)` for every read. Never calls `arrayBuffer()` on the entire selected file. Blob reads check cancellation before and after each slice; the platform's in-progress slice itself cannot be interrupted. |
| HTTP | Requires `206`, exact `Content-Range`, identity encoding, and stable size for every range. Whole-body `200` responses are cancelled before body reading. Bodies are streamed into an exact-length allocation and rejected on overflow/shortfall. Strong ETag or Last-Modified validators, when supplied, are pinned across reads. Cross-origin servers must allow Range/If-Range requests and expose Content-Range and validators. |
| Custom hosts | Supply a `RandomAccessSource` with a safe-integer `size` and a bounded `read`. Never materialize the entire input inside a host adapter. Authentication, URI restrictions, selected-file access, and transport message limits remain the host's responsibility. |

Transport or host limits can still apply even though the loader supports the
logical size. In particular, uploading one base64 message to a plugin is not a
large-file transport. Use a selected file bridge or authorized range URL.

## API

```ts
import { loadLargeModel, sourceFromBlob, sourceFromHttp } from '../src/large/index';
import type { RandomAccessSource } from '../src/large/index';

const local = sourceFromBlob(file); // browser File; no full-file allocation
const remote = await sourceFromHttp(rangeUrl, { signal });
const model = await loadLargeModel(local, {
  maxPoints: 250_000,
  maxTriangles: 150_000,
  maxReadBytes: 64 * 1024 ** 2,
  maxOutputBytes: 64 * 1024 ** 2,
  chunkBytes: 1024 ** 2,
  maxHeaderBytes: 1024 ** 2,
  signal,
  onProgress: ({ phase, readBytes, totalBytes, completedRecords, totalRecords }) => {},
});
```

`RandomAccessSource` is `{ name: string; size: number;
read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> }`.
Every call must return exactly `length` bytes. The loader checks integer ranges,
source boundaries, chunk sizes and cumulative input I/O before issuing reads.
The HTTP source's one-byte capability probe occurs before the loader's I/O budget;
include that additional byte when measuring network totals. Geometry allocation
budgets cover typed attributes, while the header and one input chunk use their own
bounded allocations. Caller-defined progress callbacks run between chunks.

The result extends `ParsedModel` with `origin` and `preview` metadata. Reconstruct
an original coordinate as `localPosition + origin`. Comparisons must account for
each model's origin rather than overlaying two independently rebased coordinate
systems as if both started at zero. Float64 source coordinates can retain small
local detail when rebased, but coordinates already stored as Float32 cannot regain
precision lost by the exporter. Very broad extents still have Float32 rendering
precision limits.

`preview` includes original vertex/triangle/polygon counts when known, retained
counts, representation, topology omission, sampling policy, record coverage,
input read counts and bytes, largest read, and full-validation status. PLY polygon
counts are not triangle counts. `coverage` is a fraction of retained **records**,
not a guarantee of spatial coverage or statistical confidence. Bounds, nearest
neighbor errors, percentiles and other comparisons over these buffers describe
the retained sample. Neither the full surface area nor the full volume can be
inferred from sampled triangles or vertex-only mesh previews.

Sampling uses up to 128 non-overlapping blocks separated evenly through record
indices. This limits request counts, includes the first and last records when at
least two records are retained, and reaches the middle of large files. It is
deterministic and may miss rare features or alias periodically ordered data.
With a one-record budget only the first record is retained. Unsampled geometry,
including face lists in PLY, is not validated. Minimum declared byte sizes are
checked; malformed values in unseen records may remain undetected.

## Reproducible verification

Run the unit suite:

```sh
node --import tsx --test tests/large.test.ts
```

It uses virtual sources larger than 5 GiB, generating bytes only for requested
ranges. Tests verify both PLY endiannesses, STL triangle previews, rebasing,
beginning/middle/end sampling, offsets above 4 GiB, I/O/chunk/output budgets,
cancellation, malformed/truncated input, unsafe counts, HTTP range validation,
revision changes and short/oversized response bodies.

Run the real-file integration check:

```sh
node scripts/large-file-test.mjs
# Or specify an available Chromium executable:
MODELDOCK_BROWSER=/path/to/chromium node scripts/large-file-test.mjs
```

The script makes actual sparse PLY and STL files each larger than 5 GiB in a
temporary directory, writes sentinel geometry at the start, middle and end, and
loads both through Chromium's real File/Blob and HTTP Range APIs. It verifies
bounded bytes/chunks, exact sentinel output, and network offsets above 4 GiB.
It prints logical versus allocated file sizes and read statistics, then removes
the fixtures. Sparse-capable storage and sufficient logical file-size support
are required. No multi-gigabyte fixture is committed or packaged.

The native OpenAI adapter also has a separate integration runner after building:

```sh
npm run build
MODELDOCK_BROWSER=/path/to/chromium node tests/openai-range-browser.mjs
```

It serves the actual bundled native app inside a simulated Desktop host, forwards
its tool calls to the real MCP SDK client/server, and injects the selected-file
path exclusively in trusted host metadata. It verifies actual >5 GiB PLY and STL
rendering, bounded reads above 4 GiB, fresh revisions on source updates, camera
preservation, rejection of a file changed between metadata lookup and reading,
subsequent recovery, and zero whole-file `resources/read` calls. The simulation
does not constitute a test inside a real installed Desktop application. It writes
a compact JSON report and screenshot to `test-results` and deletes sparse inputs.
