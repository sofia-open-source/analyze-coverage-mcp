import { readFileSync } from "fs";
import { resolve, isAbsolute } from "path";

export interface BranchData {
  line: number;
  blockNumber: number;
  branchNumber: number;
  taken: number;
}

export interface FileCoverage {
  sourceFile: string;
  functions: {
    found: number;
    hit: number;
    details: Array<{ line: number; name: string; count: number }>;
  };
  lines: {
    found: number;
    hit: number;
    details: Array<{ line: number; count: number }>;
  };
  branches: {
    found: number;
    hit: number;
    details: BranchData[];
  };
}

export interface CoverageSummary {
  lines: { found: number; hit: number; pct: number };
  functions: { found: number; hit: number; pct: number };
  branches: { found: number; hit: number; pct: number };
}

export interface UncoveredRegion {
  startLine: number;
  endLine: number;
  type: "line" | "branch";
  branchInfo?: { blockNumber: number; branchNumber: number };
}

export function parseLcov(lcovContent: string): Map<string, FileCoverage> {
  const result = new Map<string, FileCoverage>();
  let current: FileCoverage | null = null;

  for (const raw of lcovContent.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (line === "end_of_record") {
      if (current) {
        result.set(current.sourceFile, current);
        current = null;
      }
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const tag = line.substring(0, colonIdx);
    const value = line.substring(colonIdx + 1);

    if (tag === "SF") {
      current = {
        sourceFile: value,
        functions: { found: 0, hit: 0, details: [] },
        lines: { found: 0, hit: 0, details: [] },
        branches: { found: 0, hit: 0, details: [] },
      };
      continue;
    }

    if (!current) continue;

    switch (tag) {
      case "FN": {
        const [lineNo, name] = value.split(",");
        current.functions.details.push({ line: parseInt(lineNo, 10), name: name ?? "", count: 0 });
        break;
      }
      case "FNDA": {
        const commaIdx = value.indexOf(",");
        const count = parseInt(value.substring(0, commaIdx), 10);
        const name = value.substring(commaIdx + 1);
        const fn = current.functions.details.find((f) => f.name === name);
        if (fn) fn.count = count;
        break;
      }
      case "FNF":
        current.functions.found = parseInt(value, 10);
        break;
      case "FNH":
        current.functions.hit = parseInt(value, 10);
        break;
      case "DA": {
        const [lineNo, count] = value.split(",");
        current.lines.details.push({ line: parseInt(lineNo, 10), count: parseInt(count, 10) });
        break;
      }
      case "LF":
        current.lines.found = parseInt(value, 10);
        break;
      case "LH":
        current.lines.hit = parseInt(value, 10);
        break;
      case "BRDA": {
        const [lineNo, blockNo, branchNo, taken] = value.split(",");
        current.branches.details.push({
          line: parseInt(lineNo, 10),
          blockNumber: parseInt(blockNo, 10),
          branchNumber: parseInt(branchNo, 10),
          taken: taken === "-" ? 0 : parseInt(taken, 10),
        });
        break;
      }
      case "BRF":
        current.branches.found = parseInt(value, 10);
        break;
      case "BRH":
        current.branches.hit = parseInt(value, 10);
        break;
    }
  }

  return result;
}

export function parseLcovFile(lcovPath: string): Map<string, FileCoverage> {
  const content = readFileSync(lcovPath, "utf-8");
  return parseLcov(content);
}

function pct(hit: number, found: number): number {
  if (found === 0) return 100;
  return Math.round((hit / found) * 10000) / 100;
}

export function computeSummary(files: Map<string, FileCoverage>): CoverageSummary {
  let linesFound = 0,
    linesHit = 0,
    funcsFound = 0,
    funcsHit = 0,
    branchesFound = 0,
    branchesHit = 0;

  for (const fc of files.values()) {
    linesFound += fc.lines.found;
    linesHit += fc.lines.hit;
    funcsFound += fc.functions.found;
    funcsHit += fc.functions.hit;
    branchesFound += fc.branches.found;
    branchesHit += fc.branches.hit;
  }

  return {
    lines: { found: linesFound, hit: linesHit, pct: pct(linesHit, linesFound) },
    functions: { found: funcsFound, hit: funcsHit, pct: pct(funcsHit, funcsFound) },
    branches: { found: branchesFound, hit: branchesHit, pct: pct(branchesHit, branchesFound) },
  };
}

export function computeFileSummary(fc: FileCoverage): {
  file: string;
  lines: { found: number; hit: number; pct: number };
  functions: { found: number; hit: number; pct: number };
  branches: { found: number; hit: number; pct: number };
} {
  return {
    file: fc.sourceFile,
    lines: { ...fc.lines, pct: pct(fc.lines.hit, fc.lines.found) },
    functions: { ...fc.functions, pct: pct(fc.functions.hit, fc.functions.found) },
    branches: { ...fc.branches, pct: pct(fc.branches.hit, fc.branches.found) },
  };
}

export function getUncoveredRegions(fc: FileCoverage): UncoveredRegion[] {
  const regions: UncoveredRegion[] = [];

  // Collect uncovered lines and merge consecutive ones into ranges
  const uncoveredLines = fc.lines.details
    .filter((d) => d.count === 0)
    .map((d) => d.line)
    .sort((a, b) => a - b);

  if (uncoveredLines.length > 0) {
    let start = uncoveredLines[0];
    let end = uncoveredLines[0];
    for (let i = 1; i < uncoveredLines.length; i++) {
      if (uncoveredLines[i] === end + 1) {
        end = uncoveredLines[i];
      } else {
        regions.push({ startLine: start, endLine: end, type: "line" });
        start = uncoveredLines[i];
        end = uncoveredLines[i];
      }
    }
    regions.push({ startLine: start, endLine: end, type: "line" });
  }

  // Uncovered branches: taken === 0
  for (const br of fc.branches.details) {
    if (br.taken === 0) {
      regions.push({
        startLine: br.line,
        endLine: br.line,
        type: "branch",
        branchInfo: { blockNumber: br.blockNumber, branchNumber: br.branchNumber },
      });
    }
  }

  return regions.sort((a, b) => a.startLine - b.startLine);
}

export function getAnnotatedSource(
  fc: FileCoverage,
  sourceContent: string
): Array<{ line: number; covered: boolean | null; hits: number | null; code: string }> {
  const lineMap = new Map<number, number>();
  for (const d of fc.lines.details) {
    lineMap.set(d.line, d.count);
  }

  return sourceContent.split("\n").map((code, idx) => {
    const lineNo = idx + 1;
    const hits = lineMap.get(lineNo);
    return {
      line: lineNo,
      covered: hits !== undefined ? hits > 0 : null,
      hits: hits !== undefined ? hits : null,
      code,
    };
  });
}

export interface ResolveSourcePathOptions {
  /** When provided, tried first (before projectRoot). Use for explicit package root in monorepos. */
  sourceRoot?: string;
  /** Additional roots to try. For each, resolve(root, sourceFile) is attempted. */
  additionalRoots?: string[];
  /** Pre-built full paths to try (e.g. from lcov location heuristic). */
  candidates?: string[];
}

/**
 * Resolve a source file path from an LCOV record to a filesystem path.
 * Order: (1) as-is if absolute, (2) sourceRoot + path if provided, (3) projectRoot + path,
 * (4) projectRoot + path from src/lib/dist/app, (5) additionalRoots, (6) candidates.
 * See README "Path resolution and file locations".
 */
export function resolveSourcePath(
  sourceFile: string,
  projectRoot: string,
  options?: ResolveSourcePathOptions | string[]
): string | null {
  // Backward compat: options can be the legacy candidates array
  const opts: ResolveSourcePathOptions =
    Array.isArray(options) ? { candidates: options } : options ?? {};

  const toCheck: string[] = [];

  if (isAbsolute(sourceFile)) {
    toCheck.push(sourceFile);
  }

  if (opts.sourceRoot) {
    toCheck.push(resolve(opts.sourceRoot, sourceFile));
  }

  toCheck.push(resolve(projectRoot, sourceFile));

  // Strip up to the first known root segment
  for (const seg of ["src/", "lib/", "dist/", "app/"]) {
    const idx = sourceFile.indexOf(seg);
    if (idx !== -1) {
      toCheck.push(resolve(projectRoot, sourceFile.substring(idx)));
    }
  }

  if (opts.additionalRoots) {
    for (const root of opts.additionalRoots) {
      toCheck.push(resolve(root, sourceFile));
    }
  }

  if (opts.candidates) toCheck.push(...opts.candidates);

  for (const p of toCheck) {
    try {
      readFileSync(p);
      return p;
    } catch {
      // not found, try next
    }
  }

  return null;
}
