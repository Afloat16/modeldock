# Contributing

Use Node.js 22+ for the core project and the runtime required by your host for integration testing. Install the exact lockfile with `npm ci`. Run typecheck, parser/host tests, build, browser integration and the relevant native-host smoke before submitting a change.

Include an original, redistributable minimal model for format bugs. Document the exporter/version, format variant, operating system, host version, input size and error text. Do not upload private models or keys. Keep tests focused on a real risk: parser counts, binary layout, byte ownership, access boundaries, state preservation or visible interaction.

New formats need an explicit parser, bounds/limit handling, disposal and a supported-format entry. Do not silently fetch textures or external model links. New adapters must use an actual documented host interface and distinguish source-contract checks from native-host execution.

Original source contributions use MIT. Preserve dependency licensing. Changes to OpenCascade/WASM must include matching source provenance and rebuild instructions. Releases must ship appropriate third-party notices and the CAD corresponding-source materials; do not describe dependency code as MIT.

GitHub releases build the VSIX, Harness package, OpenAI plugin and complete source archive. The `modeldock-dev` VS Code publisher identifier is used for local VSIX installation; Marketplace publication requires a registered publisher and its own credentials. Fork maintainers should update repository and package-owner metadata. The bundled workflows do not publish to the Marketplace, npm or plugin directories. See [Release workflow](docs/releasing.md).
