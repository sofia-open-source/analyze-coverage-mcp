import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseLcov,
  parseLcovFile,
  computeSummary,
  computeFileSummary,
  getUncoveredRegions,
  getAnnotatedSource,
  resolveSourcePath,
} from "../src/parser.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULLY_COVERED_LCOV = `TN:
SF:src/core/core.supermodule.facade.module.ts
FN:21,(anonymous_0)
FNF:1
FNH:1
FNDA:2325,(anonymous_0)
DA:21,2325
LF:1
LH:1
BRF:0
BRH:0
end_of_record
`;

const PARTIAL_COVERAGE_LCOV = `TN:
SF:src/core/analytics/adapters/financial-records-reports-facade.service.adapter.ts
FN:13,(anonymous_0)
FN:20,(anonymous_1)
FNF:2
FNH:1
FNDA:775,(anonymous_0)
FNDA:0,(anonymous_1)
DA:15,775
DA:17,775
DA:21,0
DA:24,0
LF:4
LH:2
BRF:0
BRH:0
end_of_record
`;

const BRANCH_COVERAGE_LCOV = `TN:
SF:src/core/addresses/modules/addresses.lazy.module.loader.ts
FN:13,(anonymous_0)
FN:15,(anonymous_1)
FNF:2
FNH:2
FNDA:1,(anonymous_0)
FNDA:5,(anonymous_1)
DA:10,1
DA:11,1
DA:16,5
DA:17,5
LF:4
LH:4
BRDA:16,0,0,0
BRDA:16,0,1,5
BRDA:17,1,0,4
BRDA:17,1,1,1
BRF:4
BRH:3
end_of_record
`;

const ZERO_COVERAGE_LCOV = `TN:
SF:src/core/analytics/constants/analytics.constants.ts
FNF:0
FNH:0
DA:1,0
DA:3,0
DA:4,0
LF:3
LH:0
BRF:0
BRH:0
end_of_record
`;

const COMBINED_LCOV = FULLY_COVERED_LCOV + PARTIAL_COVERAGE_LCOV + BRANCH_COVERAGE_LCOV + ZERO_COVERAGE_LCOV;

const MULTI_FILE_WITH_UNCOVERED_LINES_LCOV = `TN:
SF:src/service.ts
FN:5,doWork
FNF:1
FNH:1
FNDA:3,doWork
DA:5,3
DA:6,3
DA:8,0
DA:9,0
DA:11,3
LF:5
LH:3
BRDA:6,0,0,3
BRDA:6,0,1,0
BRF:2
BRH:1
end_of_record
`;

// ---------------------------------------------------------------------------
// parseLcov
// ---------------------------------------------------------------------------

describe("parseLcov", () => {
  it("parses a fully covered file", () => {
    const result = parseLcov(FULLY_COVERED_LCOV);
    expect(result.size).toBe(1);
    const fc = result.get("src/core/core.supermodule.facade.module.ts")!;
    expect(fc).toBeDefined();
    expect(fc.lines.found).toBe(1);
    expect(fc.lines.hit).toBe(1);
    expect(fc.functions.found).toBe(1);
    expect(fc.functions.hit).toBe(1);
    expect(fc.branches.found).toBe(0);
    expect(fc.branches.hit).toBe(0);
  });

  it("parses function hit counts via FNDA", () => {
    const result = parseLcov(FULLY_COVERED_LCOV);
    const fc = result.get("src/core/core.supermodule.facade.module.ts")!;
    expect(fc.functions.details).toHaveLength(1);
    expect(fc.functions.details[0].count).toBe(2325);
    expect(fc.functions.details[0].name).toBe("(anonymous_0)");
    expect(fc.functions.details[0].line).toBe(21);
  });

  it("parses a partially covered file", () => {
    const result = parseLcov(PARTIAL_COVERAGE_LCOV);
    const key = "src/core/analytics/adapters/financial-records-reports-facade.service.adapter.ts";
    const fc = result.get(key)!;
    expect(fc.lines.found).toBe(4);
    expect(fc.lines.hit).toBe(2);
    expect(fc.functions.found).toBe(2);
    expect(fc.functions.hit).toBe(1);
  });

  it("marks DA lines with count 0 correctly", () => {
    const result = parseLcov(PARTIAL_COVERAGE_LCOV);
    const key = "src/core/analytics/adapters/financial-records-reports-facade.service.adapter.ts";
    const fc = result.get(key)!;
    const line21 = fc.lines.details.find((l) => l.line === 21);
    const line15 = fc.lines.details.find((l) => l.line === 15);
    expect(line21?.count).toBe(0);
    expect(line15?.count).toBe(775);
  });

  it("parses branch data (BRDA)", () => {
    const result = parseLcov(BRANCH_COVERAGE_LCOV);
    const fc = result.get("src/core/addresses/modules/addresses.lazy.module.loader.ts")!;
    expect(fc.branches.found).toBe(4);
    expect(fc.branches.hit).toBe(3);
    expect(fc.branches.details).toHaveLength(4);

    const uncoveredBranch = fc.branches.details.find(
      (b) => b.line === 16 && b.blockNumber === 0 && b.branchNumber === 0
    );
    expect(uncoveredBranch?.taken).toBe(0);
  });

  it("handles FNDA when function name does not match any FN (no-op)", () => {
    const lcov = `TN:\nSF:src/foo.ts\nFN:10,myFunc\nFN:20,otherFunc\nFNF:2\nFNH:1\nFNDA:5,unknownFunc\nFNDA:7,myFunc\nFNDA:0,otherFunc\nDA:10,7\nDA:20,0\nLF:2\nLH:1\nBRF:0\nBRH:0\nend_of_record\n`;
    const result = parseLcov(lcov);
    const fc = result.get("src/foo.ts")!;
    expect(fc.functions.details.find((f) => f.name === "myFunc")!.count).toBe(7);
    expect(fc.functions.details.find((f) => f.name === "otherFunc")!.count).toBe(0);
    expect(fc.functions.details).toHaveLength(2);
  });

  it("handles BRDA with '-' (never-taken marker) as 0", () => {
    const lcov = `TN:\nSF:src/foo.ts\nFNF:0\nFNH:0\nBRDA:5,0,0,-\nBRDA:5,0,1,3\nBRF:2\nBRH:1\nLF:0\nLH:0\nend_of_record\n`;
    const result = parseLcov(lcov);
    const fc = result.get("src/foo.ts")!;
    expect(fc.branches.details[0].taken).toBe(0);
    expect(fc.branches.details[1].taken).toBe(3);
  });

  it("parses multiple records from one string", () => {
    const result = parseLcov(COMBINED_LCOV);
    expect(result.size).toBe(4);
  });

  it("returns empty map for empty input", () => {
    expect(parseLcov("").size).toBe(0);
    expect(parseLcov("\n\n").size).toBe(0);
  });

  it("skips lines without colon", () => {
    const lcov = `TN:\nINVALID_NO_COLON\nSF:src/foo.ts\nFNF:0\nFNH:0\nLF:0\nLH:0\nBRF:0\nBRH:0\nend_of_record\n`;
    const result = parseLcov(lcov);
    expect(result.size).toBe(1);
    expect(result.get("src/foo.ts")).toBeDefined();
  });

  it("handles zero-coverage file (all DA lines = 0)", () => {
    const result = parseLcov(ZERO_COVERAGE_LCOV);
    const fc = result.get("src/core/analytics/constants/analytics.constants.ts")!;
    expect(fc.lines.found).toBe(3);
    expect(fc.lines.hit).toBe(0);
    expect(fc.lines.details.every((l) => l.count === 0)).toBe(true);
  });

  it("handles FN with missing name (uses empty string)", () => {
    const lcov = `TN:\nSF:src/foo.ts\nFN:10\nFNF:1\nFNH:0\nDA:10,0\nLF:1\nLH:0\nBRF:0\nBRH:0\nend_of_record\n`;
    const result = parseLcov(lcov);
    const fc = result.get("src/foo.ts")!;
    expect(fc.functions.details).toHaveLength(1);
    expect(fc.functions.details[0].name).toBe("");
    expect(fc.functions.details[0].line).toBe(10);
  });

  it("handles file with no functions (FNF:0)", () => {
    const result = parseLcov(ZERO_COVERAGE_LCOV);
    const fc = result.get("src/core/analytics/constants/analytics.constants.ts")!;
    expect(fc.functions.found).toBe(0);
    expect(fc.functions.hit).toBe(0);
    expect(fc.functions.details).toHaveLength(0);
  });

  it("parseLcovFile reads from filesystem and parses content", () => {
    const lcovPath = resolve(__dirname, "lcov.info");
    const result = parseLcovFile(lcovPath);
    const fromString = parseLcov(readFileSync(lcovPath, "utf-8"));
    expect(result.size).toBe(fromString.size);
    for (const [key, fc] of result) {
      expect(fc.sourceFile).toBe(fromString.get(key)!.sourceFile);
      expect(fc.lines.found).toBe(fromString.get(key)!.lines.found);
    }
  });
});

// ---------------------------------------------------------------------------
// computeSummary
// ---------------------------------------------------------------------------

describe("computeSummary", () => {
  it("returns 100% for a fully covered single file", () => {
    const files = parseLcov(FULLY_COVERED_LCOV);
    const s = computeSummary(files);
    expect(s.lines.pct).toBe(100);
    expect(s.functions.pct).toBe(100);
    expect(s.branches.pct).toBe(100);
  });

  it("calculates correct percentages for partial coverage", () => {
    const files = parseLcov(PARTIAL_COVERAGE_LCOV);
    const s = computeSummary(files);
    expect(s.lines.pct).toBe(50);
    expect(s.functions.pct).toBe(50);
  });

  it("aggregates across multiple files", () => {
    const files = parseLcov(COMBINED_LCOV);
    const s = computeSummary(files);
    // Total lines: 1 + 4 + 4 + 3 = 12 found, 1 + 2 + 4 + 0 = 7 hit
    expect(s.lines.found).toBe(12);
    expect(s.lines.hit).toBe(7);
    expect(s.lines.pct).toBeCloseTo(58.33, 1);
  });

  it("returns 100% when found is 0 (edge case: no lines tracked)", () => {
    const lcov = `TN:\nSF:src/empty.ts\nFNF:0\nFNH:0\nLF:0\nLH:0\nBRF:0\nBRH:0\nend_of_record\n`;
    const files = parseLcov(lcov);
    const s = computeSummary(files);
    expect(s.lines.pct).toBe(100);
    expect(s.functions.pct).toBe(100);
    expect(s.branches.pct).toBe(100);
  });

  it("returns correct branch pct for mixed coverage", () => {
    const files = parseLcov(BRANCH_COVERAGE_LCOV);
    const s = computeSummary(files);
    expect(s.branches.found).toBe(4);
    expect(s.branches.hit).toBe(3);
    expect(s.branches.pct).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// computeFileSummary
// ---------------------------------------------------------------------------

describe("computeFileSummary", () => {
  it("returns file path in result", () => {
    const files = parseLcov(PARTIAL_COVERAGE_LCOV);
    const key = "src/core/analytics/adapters/financial-records-reports-facade.service.adapter.ts";
    const fc = files.get(key)!;
    const summary = computeFileSummary(fc);
    expect(summary.file).toBe(key);
  });

  it("computes correct pct for each dimension", () => {
    const files = parseLcov(PARTIAL_COVERAGE_LCOV);
    const key = "src/core/analytics/adapters/financial-records-reports-facade.service.adapter.ts";
    const fc = files.get(key)!;
    const summary = computeFileSummary(fc);
    expect(summary.lines.pct).toBe(50);
    expect(summary.functions.pct).toBe(50);
    expect(summary.branches.pct).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// getUncoveredRegions
// ---------------------------------------------------------------------------

describe("getUncoveredRegions", () => {
  it("returns empty array for fully covered file", () => {
    const files = parseLcov(FULLY_COVERED_LCOV);
    const fc = files.get("src/core/core.supermodule.facade.module.ts")!;
    expect(getUncoveredRegions(fc)).toHaveLength(0);
  });

  it("returns line regions for uncovered lines", () => {
    const files = parseLcov(PARTIAL_COVERAGE_LCOV);
    const key = "src/core/analytics/adapters/financial-records-reports-facade.service.adapter.ts";
    const fc = files.get(key)!;
    const regions = getUncoveredRegions(fc).filter((r) => r.type === "line");
    // DA:21,0 and DA:24,0 — not consecutive, so they produce 2 separate ranges
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ startLine: 21, endLine: 21 });
    expect(regions[1]).toMatchObject({ startLine: 24, endLine: 24 });
  });

  it("merges consecutive uncovered lines into ranges", () => {
    const lcov = `TN:\nSF:src/x.ts\nFNF:0\nFNH:0\nDA:1,1\nDA:2,0\nDA:3,0\nDA:4,0\nDA:5,1\nDA:6,0\nLF:6\nLH:2\nBRF:0\nBRH:0\nend_of_record\n`;
    const files = parseLcov(lcov);
    const fc = files.get("src/x.ts")!;
    const regions = getUncoveredRegions(fc).filter((r) => r.type === "line");
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ startLine: 2, endLine: 4 });
    expect(regions[1]).toMatchObject({ startLine: 6, endLine: 6 });
  });

  it("returns branch regions for uncovered branches", () => {
    const files = parseLcov(BRANCH_COVERAGE_LCOV);
    const fc = files.get("src/core/addresses/modules/addresses.lazy.module.loader.ts")!;
    const branches = getUncoveredRegions(fc).filter((r) => r.type === "branch");
    expect(branches).toHaveLength(1);
    expect(branches[0].startLine).toBe(16);
    expect(branches[0].branchInfo).toMatchObject({ blockNumber: 0, branchNumber: 0 });
  });

  it("returns both line and branch regions when applicable", () => {
    const files = parseLcov(MULTI_FILE_WITH_UNCOVERED_LINES_LCOV);
    const fc = files.get("src/service.ts")!;
    const regions = getUncoveredRegions(fc);
    const lineRegions = regions.filter((r) => r.type === "line");
    const branchRegions = regions.filter((r) => r.type === "branch");
    expect(lineRegions).toHaveLength(1);
    expect(lineRegions[0]).toMatchObject({ startLine: 8, endLine: 9 });
    expect(branchRegions).toHaveLength(1);
    expect(branchRegions[0]).toMatchObject({ startLine: 6 });
  });

  it("sorts all regions by startLine", () => {
    const files = parseLcov(MULTI_FILE_WITH_UNCOVERED_LINES_LCOV);
    const fc = files.get("src/service.ts")!;
    const regions = getUncoveredRegions(fc);
    for (let i = 1; i < regions.length; i++) {
      expect(regions[i].startLine).toBeGreaterThanOrEqual(regions[i - 1].startLine);
    }
  });

  it("all lines uncovered returns ranges per consecutive group", () => {
    const files = parseLcov(ZERO_COVERAGE_LCOV);
    const fc = files.get("src/core/analytics/constants/analytics.constants.ts")!;
    const regions = getUncoveredRegions(fc).filter((r) => r.type === "line");
    // DA records: lines 1, 3, 4 — line 1 is isolated, lines 3-4 are consecutive
    expect(regions.length).toBeGreaterThanOrEqual(1);
    const allStarts = regions.map((r) => r.startLine);
    expect(allStarts).toContain(1);
    expect(allStarts.some((s) => s === 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getAnnotatedSource
// ---------------------------------------------------------------------------

describe("getAnnotatedSource", () => {
  it("annotates covered lines with hits > 0", () => {
    const files = parseLcov(FULLY_COVERED_LCOV);
    const fc = files.get("src/core/core.supermodule.facade.module.ts")!;
    // Build a source with at least 21 lines so index 20 exists
    const source = Array.from({ length: 25 }, (_, i) => `// line ${i + 1}`).join("\n");
    const annotated = getAnnotatedSource(fc, source);
    // Line 21 has DA:21,2325
    expect(annotated[20].covered).toBe(true);
    expect(annotated[20].hits).toBe(2325);
  });

  it("annotates uncovered lines (count=0) as covered=false", () => {
    const files = parseLcov(PARTIAL_COVERAGE_LCOV);
    const key = "src/core/analytics/adapters/financial-records-reports-facade.service.adapter.ts";
    const fc = files.get(key)!;
    // Build a source that has at least 24 lines
    const source = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const annotated = getAnnotatedSource(fc, source);
    expect(annotated[20].covered).toBe(false);
    expect(annotated[20].hits).toBe(0);
  });

  it("returns null for lines not tracked by LCOV", () => {
    const files = parseLcov(FULLY_COVERED_LCOV);
    const fc = files.get("src/core/core.supermodule.facade.module.ts")!;
    const source = "// line 1\n// line 2\n// line 3";
    const annotated = getAnnotatedSource(fc, source);
    // Line 1 is not in DA records
    expect(annotated[0].covered).toBeNull();
    expect(annotated[0].hits).toBeNull();
  });

  it("preserves original source code in result", () => {
    const files = parseLcov(FULLY_COVERED_LCOV);
    const fc = files.get("src/core/core.supermodule.facade.module.ts")!;
    const source = "const x = 1;";
    const annotated = getAnnotatedSource(fc, source);
    expect(annotated[0].code).toBe("const x = 1;");
  });

  it("line numbers start at 1", () => {
    const files = parseLcov(FULLY_COVERED_LCOV);
    const fc = files.get("src/core/core.supermodule.facade.module.ts")!;
    const source = "a\nb\nc";
    const annotated = getAnnotatedSource(fc, source);
    expect(annotated[0].line).toBe(1);
    expect(annotated[2].line).toBe(3);
  });

  it("handles empty source file", () => {
    const files = parseLcov(FULLY_COVERED_LCOV);
    const fc = files.get("src/core/core.supermodule.facade.module.ts")!;
    const annotated = getAnnotatedSource(fc, "");
    expect(annotated).toHaveLength(1);
    expect(annotated[0].code).toBe("");
  });
});

// ---------------------------------------------------------------------------
// resolveSourcePath
// ---------------------------------------------------------------------------

describe("resolveSourcePath", () => {
  it("returns null when no path matches", () => {
    const result = resolveSourcePath("src/nonexistent.ts", "/tmp");
    expect(result).toBeNull();
  });

  it("resolves relative path against projectRoot", () => {
    // Use the actual lcov.info we know exists in the project
    const result = resolveSourcePath(
      "lcov.info",
      resolve(__dirname)
    );
    expect(result).not.toBeNull();
  });

  it("resolves absolute path directly", () => {
    const result = resolveSourcePath(
      resolve(__dirname, "lcov.info"),
      "/tmp"
    );
    expect(result).not.toBeNull();
  });

  it("resolves via candidates when provided", () => {
    const result = resolveSourcePath(
      "nonexistent/path.ts",
      "/tmp",
      [resolve(__dirname, "lcov.info")]
    );
    expect(result).toBe(resolve(__dirname, "lcov.info"));
  });

  it("resolves via sourceRoot when provided", () => {
    const result = resolveSourcePath("lcov.info", "/tmp", {
      sourceRoot: __dirname,
    });
    expect(result).toBe(resolve(__dirname, "lcov.info"));
  });

  it("resolves via additionalRoots when provided", () => {
    const result = resolveSourcePath("lcov.info", "/tmp", {
      additionalRoots: [__dirname],
    });
    expect(result).toBe(resolve(__dirname, "lcov.info"));
  });
});

// ---------------------------------------------------------------------------
// Integration: parse real lcov.info fixture
// ---------------------------------------------------------------------------

describe("integration: real lcov.info fixture", () => {
  const LCOV_PATH = resolve(__dirname, "lcov.info");
  const content = readFileSync(LCOV_PATH, "utf-8");
  const files = parseLcov(content);

  it("parses a non-trivial number of files", () => {
    expect(files.size).toBeGreaterThan(10);
  });

  it("every record has a non-empty sourceFile", () => {
    for (const [key, fc] of files) {
      expect(key).toBeTruthy();
      expect(fc.sourceFile).toBeTruthy();
    }
  });

  it("LF matches number of DA entries for each file", () => {
    for (const fc of files.values()) {
      expect(fc.lines.details.length).toBe(fc.lines.found);
    }
  });

  it("FNF matches number of FN entries for each file", () => {
    for (const fc of files.values()) {
      expect(fc.functions.details.length).toBe(fc.functions.found);
    }
  });

  it("finds the analytics/constants file that has 0% line coverage", () => {
    const fc = files.get("src/core/analytics/constants/analytics.constants.ts")!;
    expect(fc).toBeDefined();
    expect(fc.lines.hit).toBe(0);
    expect(fc.lines.found).toBeGreaterThan(0);
  });

  it("finds a file with uncovered branches", () => {
    const fc = files.get("src/core/addresses/modules/addresses.lazy.module.loader.ts")!;
    expect(fc).toBeDefined();
    const uncoveredBranches = fc.branches.details.filter((b) => b.taken === 0);
    expect(uncoveredBranches.length).toBeGreaterThan(0);
  });

  it("overall summary has meaningful coverage percentages", () => {
    const summary = computeSummary(files);
    expect(summary.lines.pct).toBeGreaterThan(0);
    expect(summary.lines.pct).toBeLessThanOrEqual(100);
    expect(summary.functions.pct).toBeGreaterThan(0);
    expect(summary.functions.pct).toBeLessThanOrEqual(100);
  });

  it("getUncoveredRegions finds uncovered lines in analytics/constants", () => {
    const fc = files.get("src/core/analytics/constants/analytics.constants.ts")!;
    const regions = getUncoveredRegions(fc).filter((r) => r.type === "line");
    expect(regions.length).toBeGreaterThan(0);
    // All tracked lines in this file are uncovered — should be one range
    expect(regions[0].startLine).toBeGreaterThan(0);
  });

  it("no uncovered regions for 100% covered files", () => {
    const fc = files.get("src/core/core.supermodule.facade.module.ts")!;
    const regions = getUncoveredRegions(fc);
    expect(regions).toHaveLength(0);
  });
});
