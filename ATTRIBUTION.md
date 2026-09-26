# Attribution

## Upstream Project

**DavTeam Ruflos AI Agents** is built on top of the open-source
**Ruflo** project created and maintained by **RuvNet**.

- Upstream repository: https://github.com/ruvnet/ruflo
- Upstream npm package: `ruflo` (v3.45.0)
- Upstream license: MIT (see LICENSE in this repository, preserved verbatim)

## What is preserved from upstream

This project does **not** reimplement Ruflo. It depends on the real
`ruflo@3.45.0` npm package and exposes its genuine runtime — CLI, MCP
server, agent system, specialized agents, swarm orchestration, memory,
vector memory, neural/model routing, hooks, workers, plugins, security
controls, MetaHarness, doctor, and verification — through an additional
HTTP API layer and a frontend ("Osiri").

## What DavTeam adds

- The **DavTeam API** — a production HTTP server (Express) that wraps the
  real Ruflo runtime with streaming, workspace security, command
  execution, structured logging, and error handling.
- **Osiri** — the frontend intelligence/orchestration control surface that
  communicates with the DavTeam backend.
- Deployment configuration for Hugging Face Spaces.

## License

The DavTeam additions are MIT licensed. The upstream MIT license and
copyright notice (`Copyright (c) 2024-2026 ruvnet`) are preserved in the
LICENSE file. No ownership of upstream Ruflo source is claimed.
