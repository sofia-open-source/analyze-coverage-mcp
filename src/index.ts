import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync, watchFile, statSync } from "fs";
import { basename, dirname, resolve } from "path";
import {
  parseLcov,
  computeSummary,
  computeFileSummary,
  getUncoveredRegions,
  getAnnotatedSource,
  resolveSourcePath,
  type FileCoverage,
} from "./parser.js";

const server = new McpServer({
  name: "analyze-coverage-mcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Coverage cache – reloaded on refresh or file-watch events
// ---------------------------------------------------------------------------
interface CoverageStore {
  lcovPath: string;
  projectRoot: string;
  files: Map<string, FileCoverage>;
  loadedAt: Date;
}

let store: CoverageStore | null = null;

function loadStore(lcovPath: string, projectRoot: string): CoverageStore {
  const content = readFileSync(lcovPath, "utf-8");
  return {
    lcovPath,
    projectRoot,
    files: parseLcov(content),
    loadedAt: new Date(),
  };
}

function requireStore(lcovPath: string, projectRoot: string): CoverageStore {
  if (!store || store.lcovPath !== lcovPath || store.projectRoot !== projectRoot) {
    if (!existsSync(lcovPath)) {
      throw new Error(`lcov.info not found at: ${lcovPath}`);
    }
    store = loadStore(lcovPath, projectRoot);

    watchFile(lcovPath, { interval: 1000 }, () => {
      if (store && store.lcovPath === lcovPath) {
        try {
          store = loadStore(lcovPath, projectRoot);
        } catch {
          // ignore transient read errors during test runner writes
        }
      }
    });
  }

  return store;
}

function resolveFileKey(files: Map<string, FileCoverage>, filePath: string): string | null {
  if (files.has(filePath)) return filePath;
  for (const key of files.keys()) {
    if (key.endsWith(filePath) || filePath.endsWith(key)) return key;
    if (key.split("/").pop() === filePath.split("/").pop()) return key;
  }
  return null;
}

const lcovPathField = z
  .string()
  .describe(
    "Absolute path to the lcov.info file. Must exist on disk. " +
      "In monorepos, when lcov is in a coverage/ subdir (e.g. apps/pkg/coverage/lcov.info), the parent dir is used as fallback for source resolution."
  );

const projectRootField = z
  .string()
  .describe(
    "Absolute path to the root containing source files. Paths in LCOV are resolved against this. " +
      "In monorepos, use the repo root; the MCP derives the package root from lcov_path when lcov is in coverage/."
  );

// ---------------------------------------------------------------------------
// Tool: get_coverage_overview
// ---------------------------------------------------------------------------
server.tool(
  "get_coverage_overview",
  "Returns aggregated and per-file coverage statistics (lines, functions, branches %). " +
    "Use this to identify files or directories with low coverage and prioritise testing efforts.",
  {
    lcov_path: lcovPathField,
    project_root: projectRootField,
    directory_filter: z
      .string()
      .optional()
      .describe(
        "Optional path prefix to filter results, e.g. 'src/core/auth'. Only files whose LCOV path starts with this prefix are included."
      ),
    threshold: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("If set, only return files whose line coverage % is below this threshold."),
    sort_by: z
      .enum(["lines", "functions", "branches", "file"])
      .optional()
      .default("lines")
      .describe("Sort order for per-file results."),
  },
  async ({ lcov_path, project_root, directory_filter, threshold, sort_by }) => {
    try {
      const s = requireStore(lcov_path, project_root);

      let files = [...s.files.values()];
      if (directory_filter) {
        files = files.filter((f) => f.sourceFile.startsWith(directory_filter));
      }

      const summaryFiles = files.map(computeFileSummary);
      const sortKey = sort_by ?? "lines";
      summaryFiles.sort((a, b) => {
        if (sortKey === "file") return a.file.localeCompare(b.file);
        return a[sortKey].pct - b[sortKey].pct;
      });

      const filtered =
        threshold !== undefined ? summaryFiles.filter((f) => f.lines.pct < threshold) : summaryFiles;

      const overallMap = new Map(files.map((f) => [f.sourceFile, f]));
      const overall = computeSummary(overallMap);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              loadedAt: s.loadedAt.toISOString(),
              lcovPath: s.lcovPath,
              overall,
              totalFiles: files.length,
              matchedFiles: filtered.length,
              files: filtered,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: list_uncovered_regions
// ---------------------------------------------------------------------------
server.tool(
  "list_uncovered_regions",
  "Returns uncovered lines and branches for a specific file. " +
    "Consecutive uncovered lines are merged into ranges ({startLine, endLine}). " +
    "Use this as a GPS to pinpoint exactly what code paths are missing tests.",
  {
    lcov_path: lcovPathField,
    project_root: projectRootField,
    file_path: z
      .string()
      .describe(
        "Path as in LCOV, or a suffix (e.g. auth/service.ts), or unique filename. Use get_coverage_overview to list available paths."
      ),
  },
  async ({ file_path, lcov_path, project_root }) => {
    try {
      const s = requireStore(lcov_path, project_root);
      const key = resolveFileKey(s.files, file_path);
      if (!key) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `File not found in coverage data: "${file_path}". ` +
                `Available files contain ${s.files.size} entries. ` +
                `Try using get_coverage_overview to list available paths.`,
            },
          ],
        };
      }

      const fc = s.files.get(key)!;
      const regions = getUncoveredRegions(fc);

      const uncoveredLines = regions
        .filter((r) => r.type === "line")
        .map((r) => ({ startLine: r.startLine, endLine: r.endLine }));

      const uncoveredBranches = regions
        .filter((r) => r.type === "branch")
        .map((r) => ({
          line: r.startLine,
          blockNumber: r.branchInfo?.blockNumber,
          branchNumber: r.branchInfo?.branchNumber,
        }));

      const summary = computeFileSummary(fc);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              file: key,
              summary: {
                lines: summary.lines,
                functions: summary.functions,
                branches: summary.branches,
              },
              uncoveredLines,
              uncoveredBranches,
              totalUncoveredLineRanges: uncoveredLines.length,
              totalUncoveredBranches: uncoveredBranches.length,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_annotated_source
// ---------------------------------------------------------------------------
server.tool(
  "get_annotated_source",
  "Returns the source file content annotated line-by-line with coverage status ([COVERED], [NOT COV], [NO DATA]). " +
    "Provides the full picture so the agent can understand the logic around uncovered regions.",
  {
    lcov_path: lcovPathField,
    project_root: projectRootField,
    file_path: z
      .string()
      .describe(
        "Path as in LCOV, or a suffix (e.g. auth/service.ts), or unique filename. Source must exist on disk; project_root/lcov-derived roots are used for resolution."
      ),
    source_root: z
      .string()
      .optional()
      .describe(
        "Optional. Override root for resolving source files (tried before project_root). Use when heuristics fail, e.g. package root in monorepos."
      ),
    additional_roots: z
      .array(z.string())
      .optional()
      .describe(
        "Optional. Extra roots to try for resolution. For each, resolve(root, file_path) is attempted."
      ),
    start_line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("First line to include (1-based). Defaults to 1."),
    end_line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Last line to include (1-based). Defaults to end of file."),
  },
  async ({ file_path, lcov_path, project_root, source_root, additional_roots, start_line, end_line }) => {
    try {
      const s = requireStore(lcov_path, project_root);
      const key = resolveFileKey(s.files, file_path);
      if (!key) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `File not found in coverage data: "${file_path}".` }],
        };
      }

      const fc = s.files.get(key)!;

      // Derive candidate roots from lcov path (monorepo: lcov often in apps/<pkg>/coverage/)
      const candidates: string[] = [];
      const lcovDir = dirname(s.lcovPath);
      if (basename(lcovDir) === "coverage") {
        const packageRoot = dirname(lcovDir);
        candidates.push(resolve(packageRoot, key));
      }

      const resolvedPath = resolveSourcePath(key, s.projectRoot, {
        sourceRoot: source_root,
        additionalRoots: additional_roots,
        candidates,
      });

      if (!resolvedPath) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Source file "${key}" not found on disk. ` +
                `Try setting project_root, source_root, or additional_roots to the directory containing your source files.`,
            },
          ],
        };
      }

      const sourceContent = readFileSync(resolvedPath, "utf-8");
      const annotated = getAnnotatedSource(fc, sourceContent);

      const from = (start_line ?? 1) - 1;
      const to = end_line !== undefined ? end_line : annotated.length;
      const slice = annotated.slice(from, to);

      const lines = slice.map(({ line, covered, hits, code }) => {
        let label: string;
        if (covered === null) label = "[NO DATA]";
        else if (covered) label = `[COVERED] (hits:${hits})`;
        else label = "[NOT COV]";
        return `${String(line).padStart(5)} | ${label.padEnd(22)} | ${code}`;
      });

      const regions = getUncoveredRegions(fc);
      const inRange = regions.filter(
        (r) => r.startLine >= (start_line ?? 1) && r.endLine <= (end_line ?? Infinity)
      );

      const text =
        `## Coverage: \`${key}\`\n\n` +
        `**Lines:** ${fc.lines.hit}/${fc.lines.found} | ` +
        `**Branches:** ${fc.branches.hit}/${fc.branches.found}\n\n` +
        (inRange.length > 0
          ? `### Uncovered regions in this range\n` +
            inRange
              .map(
                (r) =>
                  `- Lines ${r.startLine}–${r.endLine} (${r.type}` +
                  (r.branchInfo ? ` block=${r.branchInfo.blockNumber} branch=${r.branchInfo.branchNumber}` : "") +
                  `)`
              )
              .join("\n") +
            "\n\n"
          : "") +
        "```\n" +
        lines.join("\n") +
        "\n```";

      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start — stdio transport (no HTTP, no stdout pollution)
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
