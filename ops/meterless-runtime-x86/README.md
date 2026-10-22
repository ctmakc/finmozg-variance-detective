# Meterless Runtime on an x86_64 Linux box (how this project's demo runs)

The hackathon's Power rule asks for Meterless Nightshift as the app's primary AI provider. Nightshift ships for
Windows, macOS and DGX Spark; the Linux build is aarch64 (DGX GB10) only. Our dev machine is x86_64 Linux with no
root, so we ran the **official Meterless Runtime 1.4.5 daemon** (`meterless-runtime_1.4.5-1_arm64.deb` from
https://meterless.ai/Nightshift/DGX/, SHA-256 checked against the published SHA256SUMS) like this:

| Piece | How it runs here |
|---|---|
| `meterlessd` (Rust, aarch64) | user-mode `qemu-aarch64-static` (extracted from the Ubuntu `qemu-user-static` .deb, no install) with an arm64 Ubuntu 24.04 sysroot exported from Docker |
| Engine host (Node, serves the OpenAI-compatible API on :8088) | official x86_64 Node 22.16.0, started by the daemon via `node_bin` in the config |
| Model lane `nemotron` | the daemon spawns `shim/llama-server` (llama.cpp/CUDA cannot run here); the shim speaks the llama-server HTTP surface and forwards to a local Ollama daemon serving `nemotron-3-super:cloud` |
| One catalog row | `patches/models.js-nemotron-ollama-row.diff` declares tool support for that lane (Ollama reports `tools` for the model); without it the engine strips `tools` from requests to an unknown local model |

Everything the app sees is the real Runtime: Bearer token from `<stateDir>/proxy-token`, `GET /v1/models` with the
20 `meterless/*` routing modes, 401 on a wrong token, and a signed compute receipt (`meterless.routed_model`) on
every chat completion. Receipts label the lane "local"; the Nemotron call itself goes Ollama → Ollama Cloud.

On a Mac or Windows machine none of this is needed: install Nightshift, add an NVIDIA key in Providers, put a
Nemotron model on a lane, copy the Console's Runtime URL and token into `.env`.

Files: `start.sh` / `stop.sh` (expect the unpacked deb under `opt/`, qemu under `qemu-dl/`, sysroot under
`sysroot/`, Node under `node-dl/current/`), `config.toml.template`, `lanes.toml` (goes to `state/`), `shim/`.
