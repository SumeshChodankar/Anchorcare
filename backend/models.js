import mongoose from "mongoose";

// 1. Dialogue Turn History (Stored in engram.conversations)
const ConversationSchema = new mongoose.Schema(
  {
    householdId: { type: String, default: "anchorcare-demo", index: true },
    subjectId: { type: String, default: "demo-person-001", index: true },
    patientId: { type: String, default: "arthur_01", index: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { collection: "conversations" }
);

// 2. Structured Persistent Memories / Episodes (Stored in engram.memories)
const MemorySchema = new mongoose.Schema(
  {
    householdId: { type: String, default: "anchorcare-demo", index: true },
    subjectId: { type: String, default: "demo-person-001", index: true },
    patientId: { type: String, default: "arthur_01", index: true },
    who: [{ type: String }],
    what: { type: String, required: true },
    where: { type: String },
    when: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "memories" }
);

// 3. Caregiver Alerts (Stored in engram.alerts)
const AlertSchema = new mongoose.Schema(
  {
    householdId: { type: String, default: "anchorcare-demo", index: true },
    subjectId: { type: String, default: "demo-person-001", index: true },
    patientId: { type: String, default: "arthur_01", index: true },
    type: { type: String, required: true }, // 'EMERGENCY' | 'DOSE_QUERY' | 'DISTRESS'
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { collection: "alerts" }
);

// 4. AnchorCare Canonical Source Table (Stored directly in engram.sources)
const SourceSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    householdId: { type: String, default: "anchorcare-demo", index: true },
    subjectId: { type: String, default: "demo-person-001", index: true },
    content: { type: String, required: true },
    sourceType: { type: String, default: "user_report" },
    recordedAt: { type: Date, default: Date.now },
  },
  { collection: "sources" }
);

// 5. AnchorCare Canonical Episodes Table (Stored directly in engram.episodes)
const EpisodeSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    householdId: { type: String, default: "anchorcare-demo", index: true },
    subjectId: { type: String, default: "demo-person-001", index: true },
    summary: { type: String, required: true },
    what: { type: String, required: true },
    place: { type: String, default: null },
    searchText: { type: String, required: true },
    sourceIds: [{ type: String }],
    personIds: [{ type: String }],
    eventStart: { type: Date, default: Date.now },
    eventEnd: { type: Date, default: null },
    recordedAt: { type: Date, default: Date.now },
    reviewStatus: { type: String, default: "pending_caregiver_review" }, // Draft by default
    eventStatus: { type: String, default: "reported_completed" },
    isCurrent: { type: Boolean, default: true },
  },
  { collection: "episodes" }
);

export const Conversation = mongoose.model("Conversation", ConversationSchema);
export const Memory = mongoose.model("Memory", MemorySchema);
export const Alert = mongoose.model("Alert", AlertSchema);
export const Source = mongoose.model("Source", SourceSchema);
export const Episode = mongoose.model("Episode", EpisodeSchema);
