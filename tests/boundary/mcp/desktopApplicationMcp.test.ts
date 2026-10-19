import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createPackageWithOptions } from "@electron/asar";
import { expect, it, onTestFinished } from "vitest";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { desktopApplicationSchema } from "../../../src/domain/desktopApplication.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";

it.each([false, true])(
  "follows the ASAR selection probe with a previously active target: %s",
  async (previous) => {
    const root = await createTestTempDirectory("rea-desktop-asar-probe-");
    const source = join(root, "source");
    const installation = join(root, "installation");
    const resources = join(installation, "resources");
    await mkdir(source);
    await mkdir(resources, { recursive: true });
    await writeFile(
      join(source, "selected.js"),
      "export const selected = true;\n",
    );
    const archive = join(resources, "app.asar");
    await createPackageWithOptions(source, archive, {});
    const session = createTestBinarySession(new ArtifactProvider(process.env));
    const harness = await createApplicationMcpHarness({ session });
    onTestFinished(harness.close);
    if (previous) {
      const other = join(root, "previous");
      await mkdir(other);
      await writeFile(
        join(other, "previous.js"),
        "export const previous = true;\n",
      );
      const path = join(root, "previous.asar");
      await createPackageWithOptions(other, path, {});
      const opened = await harness.client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(opened.isError).not.toBe(true);
    }
    const result = await harness.client.callTool({
      name: "inspect_desktop_application",
      arguments: { path: installation, detail: "complete" },
    });
    expect(result.isError).not.toBe(true);
    const report = desktopApplicationSchema.parse(
      parseEvidence(result.structuredContent).normalized_result,
    );
    const archiveFile = report.files.find(
      (row) => row.path === "resources/app.asar",
    );
    if (archiveFile === undefined) throw new Error("Missing selected archive");
    const probe = report.next_probes.find(
      (row) =>
        row.file_id === archiveFile.file_id &&
        row.operation !== "analyze_javascript_application",
    );
    if (probe === undefined) throw new Error("Missing archive selection probe");
    expect(probe.operation).toBe("open_binary");
    const selected = await harness.client.callTool({
      name: probe.operation,
      arguments: { path: probe.path },
    });
    expect(selected.isError).not.toBe(true);
    const inspected = await harness.client.callTool({
      name: "inspect_artifact",
      arguments: {},
    });
    expect(inspected.isError).not.toBe(true);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.structuredContent).normalized_result,
    );
    const inventory = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(inventory.occurrences.map((row) => row.logical_path)).toContain(
      "selected.js",
    );
    expect(inventory.occurrences.map((row) => row.logical_path)).not.toContain(
      "previous.js",
    );
  },
);

it("advertises exact schemas and retains a compact directory answer with typed selected pages", async () => {
  const root = await createTestTempDirectory("rea-desktop-mcp-");
  await mkdir(join(root, "resources"));
  await writeFile(join(root, "resources/app.asar"), "path marker only");
  const session = createTestBinarySession(() => {
    throw new Error("Directory inspection must not acquire a deep provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "desktop-directory-test", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const schemas = await advertisedMcpToolSchemas(
    client,
    "inspect_desktop_application",
  );
  const views = await advertisedMcpToolSchemas(client, "inspect_analysis_view");
  expect(schemas.ajv.validate(schemas.inputSchema, { path: root })).toBe(true);
  expect(
    schemas.ajv.validate(schemas.inputSchema, { path: root, execute: true }),
  ).toBe(false);
  const result = await client.callTool({
    name: "inspect_desktop_application",
    arguments: { path: root },
  });
  expect(result.isError).not.toBe(true);
  expect(
    schemas.ajv.validate(schemas.outputSchema, result.structuredContent),
    JSON.stringify(schemas.ajv.errors),
  ).toBe(true);
  const summary = parseEvidence(result.structuredContent);
  const view = analysisViewResultSchema.parse(summary.normalized_result);
  expect(view.kind).toBe("summary");
  const retained = session.evidenceById(view.parent_evidence_id);
  expect(retained).toBeDefined();
  const full = desktopApplicationSchema.parse(retained?.normalized_result);
  expect(full.candidates.map((candidate) => candidate.family)).toEqual([
    "electron",
  ]);
  const archive = full.files.find((file) => file.path === "resources/app.asar");
  if (archive === undefined)
    throw new Error("Missing retained ASAR convention");
  const selected = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: {
        kind: "desktop-application",
        collection: "files",
        file_ids: [archive.file_id],
        fields: ["path", "read_status"],
        limit: 1,
      },
    },
  });
  expect(selected.isError).not.toBe(true);
  expect(
    views.ajv.validate(views.outputSchema, selected.structuredContent),
    JSON.stringify(views.ajv.errors),
  ).toBe(true);
  const page = parseEvidence(selected.structuredContent);
  expect(page.evidence_links).toEqual([view.parent_evidence_id]);
  expect(page.normalized_result).toMatchObject({
    items: [
      {
        file_id: expect.any(String),
        path: "resources/app.asar",
        read_status: "not-selected",
      },
    ],
    source_coverage: { status: "complete-within-scan" },
    coverage: { total: 1, exhausted: true },
  });
  const complete = await client.callTool({
    name: "inspect_desktop_application",
    arguments: { path: root, detail: "complete" },
  });
  expect(complete.isError).not.toBe(true);
  expect(parseEvidence(complete.structuredContent).evidence_id).toBe(
    view.parent_evidence_id,
  );
});

it.skipIf(process.platform === "win32")(
  "retains special-entry facts and advertises batched omission selections through MCP",
  async () => {
    const root = await createTestTempDirectory("rea-desktop-omissions-mcp-");
    execFileSync("mkfifo", [join(root, "b"), join(root, "a")], {
      timeout: 10_000,
    });
    const harness = await createApplicationMcpHarness();
    onTestFinished(harness.close);
    const schemas = await advertisedMcpToolSchemas(
      harness.client,
      "inspect_analysis_view",
    );
    const inspected = await harness.client.callTool({
      name: "inspect_desktop_application",
      arguments: { path: root },
    });
    expect(inspected.isError).not.toBe(true);
    const summary = analysisViewResultSchema.parse(
      parseEvidence(inspected.structuredContent).normalized_result,
    );
    expect(summary).toMatchObject({
      summary: { available_counts: { omissions: 2 } },
    });
    const source = {
      kind: "retained-evidence",
      evidence_id: summary.parent_evidence_id,
    };
    const listed = await harness.client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source,
        view: {
          kind: "desktop-application",
          collection: "omissions",
          limit: 2,
        },
      },
    });
    expect(listed.isError).not.toBe(true);
    expect(
      schemas.ajv.validate(schemas.outputSchema, listed.structuredContent),
    ).toBe(true);
    const page = analysisViewResultSchema.parse(
      parseEvidence(listed.structuredContent).normalized_result,
    );
    if (page.kind !== "desktop-application") throw new Error("Expected rows");
    const ids = page.items.map((row) => {
      if (!("omission_id" in row) || typeof row.omission_id !== "string")
        throw new Error("Missing stable omission identity");
      return row.omission_id;
    });
    expect(page.items).toMatchObject([
      { path: "a", kind: "fifo" },
      { path: "b", kind: "fifo" },
    ]);
    for (const selection of [ids, []]) {
      const args = {
        source,
        view: {
          kind: "desktop-application",
          collection: "omissions",
          omission_ids: selection,
          fields: ["kind"],
          limit: 2,
        },
      };
      expect(schemas.ajv.validate(schemas.inputSchema, args)).toBe(true);
      const selected = await harness.client.callTool({
        name: "inspect_analysis_view",
        arguments: args,
      });
      expect(selected.isError).not.toBe(true);
      expect(
        schemas.ajv.validate(schemas.outputSchema, selected.structuredContent),
      ).toBe(true);
      const evidence = parseEvidence(selected.structuredContent);
      expect(evidence.evidence_links).toEqual([summary.parent_evidence_id]);
      expect(evidence.normalized_result).toHaveProperty(
        "items",
        selection.map((omission_id) => ({ omission_id, kind: "fifo" })),
      );
      expect(evidence.normalized_result).toMatchObject({
        source_coverage: { status: "partial" },
      });
    }
  },
);
