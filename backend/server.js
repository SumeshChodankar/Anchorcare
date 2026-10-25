import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import crypto from "crypto";

import { Conversation, Memory, Alert, Source, Episode } from "./models.js";
import { processPatientAudio } from "./gemini.js";
import { synthesizeSpeechBase64 } from "./tts.js";
import { forwardMemoryToAnchorCare } from "./anchorcareDispatcher.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 5e7,
});

// Database Connection to engram database
const MONGO_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/engram";
mongoose
  .connect(MONGO_URI)
  .then(() => console.log(" Connected to MongoDB Atlas (engram database)"))
  .catch((err) => console.warn(" MongoDB connection warning:", err.message));

app.get("/health", (req, res) => {
  res.json({ status: "healthy", database: "engram", service: "engram-companion-backend" });
});

// Caregiver REST endpoint to fetch alerts & daily memories
app.get("/api/caregiver/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;
    const memories = await Memory.find({ patientId }).sort({ createdAt: -1 }).limit(10);
    const alerts = await Alert.find({ patientId }).sort({ timestamp: -1 }).limit(5);
    res.json({ memories, alerts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Main Multimodal Turn Handler
async function handlePatientInput(patientId, { text, transcript, audioBase64, imageBase64, mimeType, cameraIsActive }) {
  const householdId = "anchorcare-demo";
  const subjectId = "demo-person-001";

  let history = [];
  let memories = [];
  try {
    history = await Conversation.find({ patientId }).sort({ timestamp: -1 }).limit(6);
    history = history.reverse();
    memories = await Memory.find({ patientId }).sort({ createdAt: -1 }).limit(10);
  } catch (_) {}

  const attachedFrame = cameraIsActive ? imageBase64 : null;

  // Process with Gemini / Knowledge Engine
  const result = await processPatientAudio(audioBase64, mimeType, history, memories, text || transcript, attachedFrame);
  const { spoken_response, extracted_memory, user_transcript, flags } = result;

  const displayUserText = text || transcript || user_transcript;
  const now = new Date();

  // Persist directly into MongoDB Atlas 'engram' database tables
  try {
    // 1. Save to engram.conversations
    if (displayUserText) {
      await Conversation.create({
        householdId,
        subjectId,
        patientId,
        role: "user",
        content: displayUserText,
        timestamp: now,
      });
      io.to(patientId).emit("conversation_update", { sender: "patient", text: displayUserText });
    }

    await Conversation.create({
      householdId,
      subjectId,
      patientId,
      role: "assistant",
      content: spoken_response,
      timestamp: new Date(),
    });

    // 2. Save structured memory to engram.memories
    if (extracted_memory && extracted_memory.what) {
      const createdMemory = await Memory.create({
        householdId,
        subjectId,
        patientId,
        who: extracted_memory.who || [],
        what: extracted_memory.what,
        where: extracted_memory.where || null,
        when: extracted_memory.when || now.toISOString(),
        createdAt: now,
      });

      // 3. Save into canonical AnchorCare tables: engram.sources & engram.episodes
      try {
        const sourceId = `source_${crypto.randomBytes(16).toString("hex")}`;
        await Source.create({
          _id: sourceId,
          householdId,
          subjectId,
          content: displayUserText || extracted_memory.what,
          sourceType: "user_report",
          recordedAt: now,
        });

        const episodeId = `ep_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        await Episode.create({
          _id: episodeId,
          householdId,
          subjectId,
          summary: extracted_memory.what,
          what: extracted_memory.what,
          place: extracted_memory.where || null,
          searchText: `${extracted_memory.what}. ${extracted_memory.where || ""}`,
          sourceIds: [sourceId],
          personIds: extracted_memory.who || [],
          eventStart: now,
          recordedAt: now,
          reviewStatus: "pending_caregiver_review", // Always draft
          eventStatus: "reported_completed",
          isCurrent: true,
        });
        console.log(`✓ [Atlas Ingestion] Committed to engram.episodes (${episodeId}) and engram.sources (${sourceId})`);
      } catch (canonicalErr) {
        console.warn("Canonical episode/source save error:", canonicalErr.message);
      }

      // 4. Background AnchorCare API forwarding
      forwardMemoryToAnchorCare(createdMemory, !!cameraIsActive).catch((err) => {
        console.warn("Background AnchorCare forward error:", err.message);
      });
    }
  } catch (dbErr) {
    console.warn("DB save warning:", dbErr.message);
  }

  // Check safety triggers (Emergency / Dosage Question / Distress)
  if (flags?.emergency || flags?.dose_question || flags?.distress) {
    const alertType = flags.emergency ? "EMERGENCY" : flags.dose_question ? "MEDICATION_DOSAGE" : "DISTRESS";
    const alertMsg = flags.emergency
      ? "Potential injury or emergency reported."
      : flags.dose_question
      ? "Patient inquired about medication dosage. Advice withheld."
      : "Patient expressed emotional distress or disorientation.";

    try {
      await Alert.create({
        householdId,
        subjectId,
        patientId,
        type: alertType,
        message: alertMsg,
        timestamp: new Date(),
      });
    } catch (_) {}

    io.to(patientId).emit("alert_triggered", {
      type: alertType,
      message: alertMsg,
      time: new Date().toISOString(),
    });
  }

  // Send assistant response update to client
  io.to(patientId).emit("conversation_update", {
    sender: "assistant",
    text: spoken_response,
  });

  // Synthesize Speech and stream back audio
  const speechBase64 = await synthesizeSpeechBase64(spoken_response);
  if (speechBase64) {
    io.to(patientId).emit("audio_response", { audioBase64: speechBase64 });
  }
}

// Socket.IO Real-time Pipeline
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.join("arthur_01");

  socket.on("join_session", ({ patientId }) => {
    socket.join(patientId);
  });

  // 1. Audio input
  socket.on("patient_audio", async (data) => {
    const { patientId, audioBuffer, transcript, imageBase64, cameraIsActive } = data;
    console.log(`[Audio Event] Patient: ${patientId}, CameraActive: ${!!cameraIsActive}`);
    const base64Audio = Buffer.from(audioBuffer).toString("base64");
    await handlePatientInput(patientId, {
      audioBase64: base64Audio,
      mimeType: "audio/wav",
      transcript,
      imageBase64,
      cameraIsActive: !!cameraIsActive,
    });
  });

  // 2. Text input
  socket.on("patient_text", async (data) => {
    const { patientId, text } = data;
    console.log(`[Text Event] Patient ${patientId}: "${text}"`);
    await handlePatientInput(patientId, { text, cameraIsActive: false });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(` Engram Multimodal Companion Backend running on port ${PORT}`);
});
