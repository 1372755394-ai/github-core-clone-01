# github-core-clone-01 — a GitHub-compatible git forge

A single-process, dependency-free (Node 22 standard library only) implementation of
the core of GitHub, built for the make.fun `github-core-clone-01` bounty.

## What it serves

- **Smart-HTTP git** — upload-pack protocol v2 (ls-refs, fetch with shallow/deepen,
  thin-pack and delta resolution) and v0, receive-pack v0 with per-ref
  fast-forward enforcement (`non-fast-forward`) and sideband report-status.
  Packfiles are read and written in code (SHA-1 objects, OFS/REF delta resolution);
  no `git` binary is used.
- **REST v3** (`/api/v3`) — repositories, branches, commits, contents, labels,
  issues, comments, pull requests (squash merge with conflict detection),
  cursor pagination via `Link` headers.
- **GraphQL** (`/api/graphql`) — `viewer`, `repository` (issues, pull requests,
  files, cursors), `node(id:)`, `__type` introspection, issue/PR mutations,
  batched operations.
- **MCP** (`/mcp`) — JSON-RPC 2.0 over streamable HTTP: modern `server/discover`
  (2026-07-28) and the legacy `initialize` handshake, six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

## Running

```sh
node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN
```

The lifecycle (`main.ts`, from the starter kit) binds an ephemeral port, registers
it with the environment, and exits when the environment reports done. The viewer
is the token's owner (`adaiversen` in the contest scenario). All served timestamps
come from a deterministic counter, so replayed trials export identical state.

## Layout

- `main.ts` — lifecycle (unchanged from the starter kit)
- `app.ts` — HTTP server, routing, auth, body handling
- `src/gitobj.ts` — git objects, packfile read/write, reachability
- `src/gitproto.ts` — smart-HTTP protocol (advertisements, ls-refs, fetch, push)
- `src/store.ts` — in-memory forge state (repos, issues, PRs, deterministic clock)
- `src/rest.ts` — REST v3 handlers
- `src/graphql.ts` — GraphQL parser and executor
- `src/mcp.ts` — MCP endpoint

## Local grade

```
node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process
```

Last local grade: **891/1000** — feature 600/600 (120/120 conformance checks),
agent 200/200 (MCP), perf 91/200.
