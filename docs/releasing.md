# Releasing ModelDock

The public repository is [Afloat16/modeldock](https://github.com/Afloat16/modeldock). Release assets are attached to [GitHub Releases](https://github.com/Afloat16/modeldock/releases). Publishing a GitHub release builds downloadable local packages; it does not publish to npm, VS Code Marketplace or an OpenAI/DeepSeek plugin directory.

## Prepare the source and version

Use a clean checkout of the reviewed commit and Node.js 24 for the complete development/test matrix. The standalone viewer and OpenAI server support Node.js 22+, while the inspected DeepSeek Harness CLI needs Node.js 24.9.0 or newer.

Keep these release versions consistent:

- `package.json`: root `version`.
- `package-lock.json`: top-level `version` and `packages[""].version`.
- `adapters/deepseek-harness/package.json`: package `version`.
- `adapters/openai/plugin.json` and `adapters/openai/.codex-plugin/plugin.json`: plugin `version`.
- `src/openai/server.ts`: MCP server version.

Update `CHANGELOG.md`, installation filenames and the executed-test record in `docs/validation.md` for the same version. For v0.2.0, the release tag must be exactly **`v0.2.0`**. The release workflow rejects a tag that differs from `v${package.json.version}`.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` creates the shared viewer, VS Code extension, local CLI, native Harness bundle and self-contained OpenAI app/server payloads. Do not package stale adapter output from a previous build.

## Run the validation matrix

After building, run the automated carrier and renderer tests:

```sh
npm run test:openai-stdio
npx playwright install --with-deps chromium
npm run test:browser
npm run test:openai-browser
npm run test:comparison
npm run test:large
npm run test:openai-range
```

These cover the bundled stdio response, ordinary shared viewer, legacy OpenAI resource delivery, multi-model comparison, actual sparse PLY/STL sources above 5 GiB, and selected-file OpenAI range delivery. The OpenAI browser carriers are simulated Desktop hosts using real app/SDK code; passing them does not establish installation or CSP compatibility in a real OpenAI Desktop release. Large-file tests validate bounded previews, not complete 5 GiB rendering or CAD conversion.

Run native VS Code extension acceptance with a display. On Linux CI:

```sh
xvfb-run -a npm run test:extension
```

A successful unit/browser run does not replace this native-host gate. Record a missing local display or failed host launch as an unexecuted/failed acceptance step, rather than a pass. The GitHub build workflow runs the automated commands and VS Code under Xvfb, then uploads `test-results/` even after failure, retaining that diagnostic artifact for 14 days.

Native Harness acceptance is separate from CI. Follow [the isolated-profile Web procedure](harness-integration.md#reproduce-native-web-validation): build/pack the adapter, install it into disposable `DSH_HOME` and `DSH_AGENTS_HOME` locations, start the pinned host, then run `tests/harness-browser.mjs` against its printed local URL. The correct launch is:

```sh
npx @deepseek-ai/dsh@0.2.2-alpha.2 --profile web
```

Do not insert an additional `web` positional command before `--profile web`. Do not use an ordinary working profile for the smoke test. Native Harness Web results, Desktop results, and simulated OpenAI results must be labeled separately in the validation record. No chat message or API key is required for the documented file-preview test.

## Package and inspect

```sh
npm run package:vsix
npm run package:release
```

`package:release` requires the built artifacts and versioned VSIX. It also runs `scripts/fetch-cad-source.mjs`, which downloads the pinned corresponding OpenCascade/occt-import-js source archives when absent and verifies both byte size and SHA-256 against `third_party/cad-source/provenance.json`. Those approximately 52 MB archives stay outside Git history. They are included in the complete source release ZIP alongside source/build procedures, prebuilt runtime files, notices and the binary packages. To verify/download them independently:

```sh
node scripts/fetch-cad-source.mjs
```

Inspect the five v0.2.0 deliverables:

| Asset                            | Purpose                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `modeldock-0.2.0.vsix`           | Local VS Code extension installation                                                                         |
| `dsh-plugin-modeldock-0.2.0.tgz` | Native DeepSeek Harness plugin                                                                               |
| `modeldock-openai-0.2.0.zip`     | Portable OpenAI plugin and local marketplace layout                                                          |
| `modeldock-0.2.0-source.zip`     | Complete source/build distribution, prebuilt payloads, binary packages and verified corresponding CAD source |
| `SHA256SUMS.txt`                 | SHA-256 checksums for the four distributable archives                                                        |

Binary packages include their applicable licenses and third-party notices. Keep the complete source release available with the binaries so the matching CAD corresponding-source material and rebuilding procedure remain obtainable. ModelDock's original code is MIT; the bundled CAD dependency retains its own LGPL obligations. See [third-party notices](../THIRD_PARTY_NOTICES.md) and [CAD source provenance](cad-source.md).

On a platform with `sha256sum`, verify the completed assets from the release directory:

```sh
cd releases
sha256sum --check SHA256SUMS.txt
```

Keep test results, host profiles, temporary sparse fixtures, machine-specific paths and credentials out of public source/release contents. The packaging script excludes test results, dependency installs, Git internals and release-output recursion; inspect the resulting archive rather than assuming every temporary file is automatically excluded.

## Publish the GitHub release

Push the reviewed source to the public repository and confirm the build workflow's result for that commit. In GitHub Releases, create a release for tag **`v0.2.0`** at the reviewed commit, add release notes describing supported boundaries and executed validation, and publish it. A draft alone does not trigger the release workflow.

The `Package release` workflow runs on a published release. It checks the tag/version, installs locked dependencies, typechecks/tests, builds, verifies the stdio bundle, creates the VSIX and complete release packages, and attaches the five assets with `gh release upload`. CAD source downloads are verified before inclusion. This packaging workflow is smaller than the full CI matrix, so the reviewed commit's full build/test workflow still matters.

After the workflow succeeds, verify that all five assets appear on the intended release, filenames match the tag, checksums validate, and the source ZIP contains the matching CAD source and notices. Keep the validation record explicit about any native-host acceptance that remains unexecuted.

The VSIX currently uses local publisher ID **`modeldock-dev`**. That is a package identity for local installation, not evidence of a registered Marketplace publisher. Marketplace publication requires the maintainer's registered publisher and credentials; npm publication and public plugin-directory review are separate actions. None is performed by these GitHub workflows.
