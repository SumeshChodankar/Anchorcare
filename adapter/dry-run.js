import { getSourceMemories, loadMapping, loadCheckpoint, buildAnchorCarePayload } from "./transformer.js";

async function runDryRun() {
  console.log("===============================================================================");
  console.log("              ANCHORCARE INGESTION ADAPTER — READ-ONLY DRY-RUN                 ");
  console.log("===============================================================================\n");

  const mapping = loadMapping();
  const checkpoint = loadCheckpoint();
  const importedSet = new Set(checkpoint.imported_record_ids || []);

  console.log(`[Config] Loaded Patient Mappings:`, Object.keys(mapping));
  console.log(`[Checkpoint] Already Imported Count:`, importedSet.size);

  let sourceRecords = [];
  try {
    sourceRecords = await getSourceMemories();
    console.log(`[Source DB] Found ${sourceRecords.length} records in test.memories\n`);
  } catch (err) {
    console.error("[Error] Failed to read source database:", err.message);
    process.exit(1);
  }

  const summary = {
    total: sourceRecords.length,
    already_imported: 0,
    ready_to_import: 0,
    needs_review: 0,
    unmapped_rejected: 0,
  };

  console.log("-------------------------------------------------------------------------------");
  console.log("| Source ID               | Patient   | Proposed Dest     | Review Status | Action");
  console.log("-------------------------------------------------------------------------------");

  for (const doc of sourceRecords) {
    const id = String(doc._id);
    const pid = doc.patientId || "UNKNOWN";

    if (importedSet.has(id)) {
      summary.already_imported++;
      console.log(`| ${id.padEnd(23)} | ${pid.padEnd(9)} | (Already Imported)| APPROVED/DRAFT| SKIP (Idempotent)`);
      continue;
    }

    const evaluation = buildAnchorCarePayload(doc, mapping);

    if (evaluation.reason && evaluation.reason.includes("Unmapped patient")) {
      summary.unmapped_rejected++;
      console.log(`| ${id.padEnd(23)} | ${pid.padEnd(9)} | NONE (Unmapped)   | REJECTED      | REJECT (Unmapped)`);
      continue;
    }

    if (evaluation.needsReview) {
      summary.needs_review++;
      console.log(`| ${id.padEnd(23)} | ${pid.padEnd(9)} | ${evaluation.proposedHousehold}/${evaluation.proposedSubject} | NEEDS_REVIEW  | SKIP (Missing Event Time)`);
      continue;
    }

    if (evaluation.canImport) {
      summary.ready_to_import++;
      console.log(`| ${id.padEnd(23)} | ${pid.padEnd(9)} | ${evaluation.proposedHousehold}/${evaluation.proposedSubject} | DRAFT PENDING | READY TO IMPORT`);
    }
  }

  console.log("-------------------------------------------------------------------------------\n");
  console.log("DRY-RUN SUMMARY:");
  console.log(`  Total Evaluated:       ${summary.total}`);
  console.log(`  Already Imported:      ${summary.already_imported} (Skipped for idempotency)`);
  console.log(`  Ready for Import:      ${summary.ready_to_import} (Proposed as DRAFT)`);
  console.log(`  Needs Human Review:    ${summary.needs_review} (Ambiguous or missing event times)`);
  console.log(`  Unmapped Rejected:     ${summary.unmapped_rejected} (Safety rejection)`);
  console.log("\n[Notice] Zero modifications were made to any database or endpoint.");
}

runDryRun().catch((err) => {
  console.error("Dry run fatal error:", err);
  process.exit(1);
});
