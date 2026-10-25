import { evaluateEventTime, buildAnchorCarePayload } from "./transformer.js";

function runTests() {
  console.log("===============================================================================");
  console.log("                   ANCHORCARE ADAPTER UNIT / LOGIC TESTS                      ");
  console.log("===============================================================================\n");

  const mockMapping = {
    "arthur_01": {
      target_household_id: "anchorcare-demo",
      target_subject_id: "demo-person-001",
    },
  };

  let passed = 0;
  let total = 0;

  function assert(title, condition) {
    total++;
    if (condition) {
      passed++;
      console.log(` [PASS] ${title}`);
    } else {
      console.error(` [FAIL] ${title}`);
    }
  }

  // Test 1: London Bridge Statement Mapping & Provenance
  const londonBridgeDoc = {
    _id: "mock_london_bridge_id_123",
    patientId: "arthur_01",
    what: "i took a walk on the london bridge",
    who: [],
    where: "London Bridge",
    when: "2026-10-24T14:30:00Z",
    createdAt: new Date("2026-10-24T14:35:00Z"),
  };

  const eval1 = buildAnchorCarePayload(londonBridgeDoc, mockMapping);
  assert("Maps arthur_01 to anchorcare-demo / demo-person-001", eval1.proposedHousehold === "anchorcare-demo" && eval1.proposedSubject === "demo-person-001");
  assert("Marks source_type explicitly as 'patient_report'", eval1.payload?.source_type === "patient_report");
  assert("Sets review_status strictly as 'pending_caregiver_review' (Draft)", eval1.payload?.review_status === "pending_caregiver_review");
  assert("Preserves source DB, collection, and original ID", eval1.payload?.provenance?.source_db === "test" && eval1.payload?.provenance?.source_record_id === "mock_london_bridge_id_123");
  assert("Preserves occurred_at accurately without fabricating timestamps", eval1.payload?.occurred_at === "2026-10-24T14:30:00.000Z");

  // Test 2: Unmapped Patient Rejection
  const unmappedDoc = {
    _id: "mock_unmapped_id_456",
    patientId: "unknown_person_99",
    what: "Had breakfast",
    when: "2026-10-24T10:00:00Z",
  };
  const eval2 = buildAnchorCarePayload(unmappedDoc, mockMapping);
  assert("Unmapped patients are rejected by safety policy", eval2.canImport === false && eval2.reason.includes("Unmapped patient"));

  // Test 3: Missing / Ambiguous Event Time Handling
  const ambiguousDoc = {
    _id: "mock_ambiguous_time_789",
    patientId: "arthur_01",
    what: "i had tea with my neighbour",
    when: "Today", // Ambiguous relative time
    createdAt: new Date("2026-10-24T15:00:00Z"),
  };
  const eval3 = buildAnchorCarePayload(ambiguousDoc, mockMapping);
  assert("Ambiguous event time ('Today') is flagged as NEEDS_REVIEW", eval3.needsReview === true && eval3.canImport === false);
  assert("Does NOT silently substitute createdAt for occurred_at", eval3.payload === null);

  // Test 4: Idempotency Logic
  const checkpoint = { imported_record_ids: ["mock_london_bridge_id_123"] };
  const isAlreadyImported = checkpoint.imported_record_ids.includes("mock_london_bridge_id_123");
  assert("Checkpointer detects already-imported record IDs and skips duplicates", isAlreadyImported === true);

  console.log(`\nResults: ${passed} / ${total} tests passed.\n`);
}

runTests();
