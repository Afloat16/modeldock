# Security scope

ModelDock is a local, read-only previewer. It does not intentionally upload models, run model-embedded code, fetch external texture references or send telemetry. The CLI only exposes a selected file behind a random loopback URL. Native adapters rely on their host's existing selected-file authorization.

Untrusted files still exercise third-party parsers, WebAssembly, browser image decoders and GPU drivers. Size/count guards and worker termination reduce accidental resource exhaustion; they do not guarantee protection against every parser or driver defect. Very large CAD files can consume substantial memory before tessellation returns. Use a maintained host/runtime and avoid distributing a preview package with known vulnerable dependencies.

For a suspected issue, use GitHub private vulnerability reporting when it is enabled for the affected repository. Otherwise, arrange a private reporting channel with the maintainer before sharing sensitive details. Include a minimal non-sensitive reproduction and affected versions. Do not publish proprietary models or active private viewer URLs.

The release is not an independent security audit. The validation record lists the checks actually executed.
