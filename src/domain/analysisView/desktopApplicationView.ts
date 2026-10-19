import { z } from "zod";
import {
  desktopApplicationSchema,
  desktopFileSchema,
  desktopOmissionSchema,
  desktopCandidateSchema,
  desktopComponentSchema,
  desktopProbeSchema,
  desktopFamilySchema,
  desktopCoverageSchema,
  type DesktopApplication,
} from "../desktopApplication.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { parseAnalysisViewResult } from "./analysisViewParent.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { ok, err, type Result } from "../result.js";

const page = {
  kind: z.literal("desktop-application"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
};
export const desktopViewRequestSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    ...page,
    collection: z.literal("files"),
    paths: z.array(z.string()).optional(),
    file_ids: z.array(desktopFileSchema.shape.file_id).optional(),
    fields: z.array(desktopFileSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("candidates"),
    families: z.array(desktopFamilySchema).optional(),
    fields: z.array(desktopCandidateSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("omissions"),
    paths: z.array(z.string()).optional(),
    omission_ids: z.array(desktopOmissionSchema.shape.omission_id).optional(),
    fields: z.array(desktopOmissionSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("components"),
    fields: z.array(desktopComponentSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("next_probes"),
    fields: z.array(desktopProbeSchema.keyof()).optional(),
  }),
]);
export const desktopViewItemsSchema = z.array(
  z.union([
    desktopFileSchema.partial(),
    desktopOmissionSchema.partial(),
    desktopCandidateSchema.partial(),
    desktopComponentSchema.partial(),
    desktopProbeSchema.partial(),
  ]),
);
export const desktopSummarySchema = z.strictObject({
  root: desktopApplicationSchema.shape.root,
  source_coverage: desktopCoverageSchema,
  available_counts: z.strictObject({
    files: z.number().int().nonnegative(),
    omissions: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    components: z.number().int().nonnegative(),
    next_probes: z.number().int().nonnegative(),
  }),
  candidates: z.array(
    desktopCandidateSchema.omit({ basis_file_ids: true }).extend({
      basis_file_count: z.number().int().positive(),
      basis_path_preview: z.array(z.string()),
    }),
  ),
  components: z.array(
    desktopComponentSchema.omit({ basis_file_ids: true }).extend({
      basis_file_count: z.number().int().positive(),
      basis_path_preview: z.array(z.string()),
    }),
  ),
  next_probe_groups: z.array(
    z.strictObject({
      operation: desktopProbeSchema.shape.operation,
      count: z.number().int().positive(),
      example: desktopProbeSchema,
    }),
  ),
});

type DesktopCollection = z.infer<typeof desktopViewRequestSchema>["collection"];
type DesktopViewRow = DesktopApplication[DesktopCollection][number];

// Only immutable authenticated parent objects are reused. They are not live filesystem caches.
const validatedParents = new WeakSet<object>();
export const projectDesktopApplicationView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "desktop-application")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Desktop directory Evidence supports summary and desktop-application views.",
        },
      ]),
    );
  const key =
    typeof parent.normalizedResult === "object" &&
    parent.normalizedResult !== null
      ? parent.normalizedResult
      : undefined;
  const reusable =
    parent.sealedResult === true && key !== undefined && Object.isFrozen(key);
  let report =
    reusable && validatedParents.has(key)
      ? (key as DesktopApplication)
      : undefined;
  if (report === undefined) {
    const parsed = parseAnalysisViewResult(desktopApplicationSchema, parent);
    if (!parsed.ok) return parsed;
    report = parsed.value;
    if (reusable) {
      // The schema has no coercions or transforms. Borrow the validated frozen
      // owner value instead of retaining a second unaccounted copy of its files.
      report = key as DesktopApplication;
      validatedParents.add(key);
    }
  }
  if (
    parent.subject === undefined ||
    parent.subject === null ||
    parent.subject.format !== "directory" ||
    parent.subject.local_path !== report.root.path ||
    parent.subject.digest.sha256 !== report.root.snapshot_sha256
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message: "Parent must identify the same examined directory snapshot.",
        },
      ]),
    );
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_desktop_application" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.root.path, sha256: report.root.snapshot_sha256 },
    limitations: [...new Set([...parent.limitations, ...report.limitations])],
    unknowns: [
      "Runtime behavior and unread bytes remain unknown.",
      ...(report.coverage.status === "partial"
        ? [
            "Source inspection is partial; an exhausted page does not establish absence.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary") {
    const byId = new Map(report.files.map((file) => [file.file_id, file.path]));
    const summarizeBasis = <T extends { basis_file_ids: string[] }>(row: T) => {
      const { basis_file_ids, ...value } = row;
      return {
        ...value,
        basis_file_count: basis_file_ids.length,
        basis_path_preview: basis_file_ids
          .slice(0, 2)
          .map((id) => byId.get(id) ?? id),
      };
    };
    const groups = new Map<
      string,
      {
        operation: DesktopApplication["next_probes"][number]["operation"];
        count: number;
        example: DesktopApplication["next_probes"][number];
      }
    >();
    for (const probe of report.next_probes) {
      const group = groups.get(probe.operation);
      if (group === undefined)
        groups.set(probe.operation, {
          operation: probe.operation,
          count: 1,
          example: probe,
        });
      else group.count++;
    }
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: {
        root: report.root,
        source_coverage: report.coverage,
        available_counts: {
          files: report.files.length,
          omissions: report.omissions.length,
          candidates: report.candidates.length,
          components: report.components.length,
          next_probes: report.next_probes.length,
        },
        candidates: report.candidates.map(summarizeBasis),
        components: report.components.map(summarizeBasis),
        next_probe_groups: [...groups.values()],
      },
      coverage: completeWithinViewCoverage(
        report.files.length,
        report.files.length,
      ),
    });
  }
  let rows: readonly DesktopViewRow[] = report[view.collection];
  if (view.collection === "files" || view.collection === "omissions") {
    const paths = view.paths === undefined ? undefined : new Set(view.paths);
    const ids = view.collection === "files" ? view.file_ids : view.omission_ids;
    const selected = ids === undefined ? undefined : new Set(ids);
    if (paths !== undefined || selected !== undefined)
      rows = report[view.collection].filter(
        (row) =>
          (paths === undefined || paths.has(row.path)) &&
          (selected === undefined ||
            selected.has("file_id" in row ? row.file_id : row.omission_id)),
      );
  }
  if (view.collection === "candidates" && view.families !== undefined) {
    const selected = new Set(view.families);
    rows = report.candidates.filter((row) => selected.has(row.family));
  }
  const idField = {
    files: "file_id",
    omissions: "omission_id",
    candidates: "candidate_id",
    components: "component_id",
    next_probes: "probe_id",
  }[view.collection];
  const fields =
    view.fields === undefined
      ? undefined
      : new Set<string>([idField, ...view.fields]);
  const items = rows
    .slice(view.offset, view.offset + view.limit)
    .map((row) =>
      fields === undefined
        ? row
        : Object.fromEntries(
            Object.entries(row).filter(([field]) => fields.has(field)),
          ),
    );
  return ok({
    kind: "desktop-application",
    view,
    ...shared,
    source_coverage: report.coverage,
    items: desktopViewItemsSchema.parse(items),
    coverage: pageViewCoverage(view.offset, items.length, rows.length),
  });
};
