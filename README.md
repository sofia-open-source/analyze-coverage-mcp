# analyze-coverage-mcp

[![MCP Server](https://badge.mcpx.dev?type=server)](https://modelcontextprotocol.com)
[![NPM Version](https://img.shields.io/npm/v/@sofia-open-source/analyze-coverage-mcp.svg)](https://www.npmjs.com/package/@sofia-open-source/analyze-coverage-mcp)
[![codecov](https://codecov.io/gh/sofia-open-source/analyze-coverage-mcp/graph/badge.svg?token=L1W2GXUCB6)](https://codecov.io/gh/sofia-open-source/analyze-coverage-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MCP server that bridges LCOV coverage reports to AI agents. It runs locally and gives agents precise, structured visibility into test coverage — which lines are hit, which branches are missed, and where to focus testing efforts.

## What is LCOV?

LCOV is a standard text format for code coverage data. It records which lines, functions, and branches were executed during tests. The format is widely supported by test runners (Vitest, Jest, Istanbul, etc.) and is typically written to `lcov.info`. Each record describes coverage for a source file: line hits, branch hits, and function hits.

## Tools

| Tool | Description |
|------|-------------|
| `get_coverage_overview` | Aggregated and per-file coverage stats (lines, functions, branches %). Supports filtering by directory prefix, threshold, and sort order. |
| `list_uncovered_regions` | Uncovered lines (merged into ranges) and uncovered branches for a specific file. |
| `get_annotated_source` | Full source file annotated line-by-line with `[COVERED]`, `[NOT COV]`, or `[NO DATA]`. Supports `start_line`/`end_line` windowing. |

The server also watches `lcov.info` for changes (polling every 1 s) and auto-reloads — so coverage stays current while tests run in watch mode.

## Requirements

| Parameter | Requirement |
|-----------|-------------|
| `lcov_path` | Must be an **absolute** path. The file must exist on disk. |
| `project_root` | Must be an **absolute** path to the directory containing your source files. |

### Expected project structure

For the automatic path resolution to work, your project must follow this layout:

```
<package_root>/          ← directory where tests run (e.g. apps/app-api)
├── coverage/
│   └── lcov.info
└── src/
    └── ...
```

**`src/` and `coverage/` must be siblings** under the same package root. This is the default layout when Vitest or Jest outputs coverage to `./coverage/`.

If your structure differs, use `source_root` or `additional_roots` (see [Path resolution and file locations](#path-resolution-and-file-locations)).

## Installation

### From npm

#### Configure MCP

```json
{
  "mcpServers": {
    "analyze-coverage": {
      "command": "npx",
      "args": [
        "-y",
        "@sofia-open-source/analyze-coverage-mcp"
      ]
    }
  }
}
```

### From source

#### Build and install

```bash
pnpm bundle # generates js bundle in ./analyze-coverage-mcp with shebang node executable
chmod +x ./analyze-coverage-mcp # make it executable
cp ./analyze-coverage-mcp ~/.local/bin/analyze-coverage-mcp # available in $PATH
```

#### Configure MCP

```json
{
  "mcpServers": {
    "analyze-coverage": {
      "command": "analyze-coverage-mcp"
    }
  }
}
```

## Development

```bash
# Install dependencies
pnpm install

# Run in watch mode (no build needed)
pnpm dev

# Type-check and build
pnpm build

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage
```

## How it works

1. The agent calls `get_coverage_overview` with `lcov_path` and `project_root` to load the report.
2. The LCOV file is parsed in-memory into a `Map<filename, FileCoverage>` and cached.
3. Subsequent tool calls reuse the cache (identified by `lcov_path` + `project_root`) or trigger a reload via `refresh_coverage`.
4. Source paths are resolved with fallbacks: `project_root` + path, common prefix stripping (`src/`, `lib/`, etc.), and when lcov is in `coverage/`, the parent directory is used for monorepos. See [Path resolution and file locations](#path-resolution-and-file-locations).

## Generating LCOV reports

The MCP server reads `lcov.info` files. Here’s how to generate them with common test runners:

### Vitest

Install the coverage provider:

```bash
pnpm add -D @vitest/coverage-v8
```

Configure `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
})
```

Run tests with coverage:

```bash
pnpm vitest run --coverage
```

Output: `./coverage/lcov.info`

### Jest

Install Istanbul (used by Jest for coverage):

```bash
pnpm add -D jest @types/jest
```

Configure `jest.config.js` or `package.json`:

```json
{
  "jest": {
    "collectCoverage": true,
    "coverageReporters": ["text", "lcov"],
    "coverageDirectory": "coverage"
  }
}
```

Run tests with coverage:

```bash
pnpm jest --coverage
```

Output: `./coverage/lcov.info`

### Istanbul / nyc

```bash
pnpm add -D nyc
```

Configure `package.json`:

```json
{
  "nyc": {
    "reporter": ["text", "lcov"],
    "report-dir": "coverage"
  }
}
```

Run tests with coverage:

```bash
pnpm nyc pnpm test
```

Output: `./coverage/lcov.info` (or `.nyc_output/lcov.info` depending on config)

### Other runners

Most runners support LCOV via plugins or built-in options. Ensure the reporter outputs `lcov` and that the path to `lcov.info` is passed as `lcov_path` to the MCP tools.

## Inputs

All tools require:

| Field | Type | Description |
|-------|------|-------------|
| `lcov_path` | `string` | Absolute path to the `lcov.info` file generated by your test suite |
| `project_root` | `string` | Absolute path to the root of the project being analysed |

Typical `lcov_path` values:
- Vitest with `@vitest/coverage-v8`: `<project>/coverage/lcov.info`
- Jest with `--coverage`: `<project>/coverage/lcov.info`
- Istanbul/nyc: `<project>/.nyc_output/lcov.info`

## Path resolution and file locations

See [Requirements](#requirements) for parameter and structure requirements.

### How paths work in LCOV

LCOV records store source file paths **relative to the package that ran the tests**. For example, if tests run from `apps/app-api`, paths look like `src/core/auth/service.ts`, not `apps/app-api/src/core/auth/service.ts`.

### Monorepos

In monorepos, `project_root` is often the repo root (e.g. `/repo`), but LCOV paths are relative to the package root (e.g. `apps/app-api`). The MCP handles this automatically:

- When `lcov_path` is inside a `coverage/` directory (e.g. `apps/app-api/coverage/lcov.info`), the **parent of that directory** is used as a fallback source root.
- So `project_root` can be the monorepo root; source files under `apps/app-api/src/` are still resolved correctly.

**Example:** `lcov_path: /repo/apps/app-api/coverage/lcov.info` with `project_root: /repo` → sources resolve under `/repo/apps/app-api/`.

### Source path resolution order

For `get_annotated_source`, the MCP resolves LCOV paths to filesystem paths in this order:

1. **Absolute path** — if the LCOV path is already absolute.
2. **`source_root` + path** — when `source_root` is provided (optional param).
3. **`project_root` + path** — e.g. `project_root/src/foo.ts`.
4. **Stripped prefixes** — if the path contains `src/`, `lib/`, `dist/`, or `app/`, tries `project_root` + the path from that segment onward.
5. **`additional_roots`** — for each root in this optional array, tries `root + path`.
6. **Derived from lcov location** — when lcov is in `coverage/`, tries the parent directory of `coverage/` as root.

### Flexible overrides (`get_annotated_source`)

When the automatic heuristics fail, use these optional parameters:

| Parameter | Description |
|-----------|-------------|
| `source_root` | Override root for resolving source files. Tried **before** `project_root`. Use when you know the package root (e.g. `apps/app-api`). |
| `additional_roots` | Array of extra roots to try. For each, `resolve(root, file_path)` is attempted. Useful when sources live in multiple directories. |

**Example:** `get_annotated_source` with `source_root: "/repo/apps/app-api"` forces resolution under that directory, ignoring `project_root` for that call.

### `file_path` matching

For `list_uncovered_regions` and `get_annotated_source`, `file_path` can be:

- The **exact path** as it appears in the LCOV report (e.g. `src/core/auth/service.ts`).
- A **suffix** that uniquely identifies the file (e.g. `auth/service.ts` or `service.ts`).
- A **filename** if it is unique across the report (e.g. `service.ts`).

Use `get_coverage_overview` to list available paths when unsure.

### Restrictions and pitfalls

- **Source file must exist on disk for `get_annotated_source`.** That tool reads the source to annotate it. If resolution fails: *"Source file not found on disk. Try setting project_root, source_root, or additional_roots to the directory containing your source files."* `list_uncovered_regions` only uses coverage data and does not require the source file.
- **Use `source_root` or `additional_roots` when heuristics fail.** When the automatic monorepo detection fails, pass `source_root` with the package root (e.g. `apps/app-api`), or use `additional_roots` to add extra search paths.
- **Paths are case-sensitive** on most systems.

## License

MIT
