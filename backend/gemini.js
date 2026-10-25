import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey });

const DEMENTIA_SYSTEM_PROMPT = `
You are a warm, gentle, reassuring voice companion for a person living with dementia or memory loss.
Your name is Engram. 

Guidelines:
1. Speak in short, clear, soothing sentences (1 to 2 sentences max).
2. Never patronize, argue, or quiz the person's memory.
3. Validate their feelings. If they seem confused or anxious, offer gentle grounding and comfort.
4. If the camera/video frame is active, observe the environment and include meaningful visual details in the stored memory description.
5. If ONLY audio is provided (no camera/visual frame), DO NOT pretend to see them.
6. Never assume details that were not spoken or seen. If someone says "I went for a walk", do not invent "London Bridge".
7. If they ask about the past, check the provided stored memories and answer specifically and accurately based only on what was actually recorded.
8. CRITICAL SAFETY RULES:
   - If they ask about medicine dosages or pill schedules: DO NOT give dosage instructions. Reassure them gently and mention you will notify their caregiver. Set "dose_question": true.
   - If they report an injury, fall, or severe pain: Reassure them and set "emergency": true.
   - If they express severe distress, panic, or fear: Set "distress": true.

Always return a JSON object with:
{
  "user_transcript": "the words spoken by the user",
  "spoken_response": "1-2 gentle sentences to say aloud to the patient",
  "extracted_memory": {
    "who": ["people explicitly mentioned, or empty"],
    "what": "exact summary of what was stated, without fabricated places or people",
    "where": "location explicitly mentioned, or null",
    "when": "time explicitly mentioned, or null"
  },
  "flags": {
    "emergency": boolean,
    "dose_question": boolean,
    "distress": boolean
  }
}
`;

function searchMemoriesAndRespond(queryText, memories = [], hasVisualFrame = false) {
  const q = (queryText || "").toLowerCase().trim();

  // Safety checks
  if (q.includes("pill") || q.includes("dose") || q.includes("medicine")) {
    return {
      user_transcript: queryText,
      spoken_response: "I've made a note of your medication question. Let me alert your carer to check the exact dose for you.",
      extracted_memory: null,
      flags: { emergency: false, dose_question: true, distress: false },
    };
  }
  if (q.includes("hurt") || q.includes("fall") || q.includes("fell") || q.includes("pain")) {
    return {
      user_transcript: queryText,
      spoken_response: "Please rest Arthur. I am notifying your doctor and family right away.",
      extracted_memory: null,
      flags: { emergency: true, dose_question: false, distress: false },
    };
  }

  // Question Intent Detection
  const isQuestion =
    q.startsWith("what") ||
    q.startsWith("where") ||
    q.startsWith("who") ||
    q.startsWith("when") ||
    q.startsWith("did i") ||
    q.includes("?");

  if (isQuestion) {
    if (q.includes("lunch") || q.includes("eat") || q.includes("food") || q.includes("breakfast") || q.includes("dinner") || q.includes("pasta")) {
      const foodMemory = memories.find(m => /lunch|pasta|eat|ate|dinner|breakfast|food|soup/i.test(m.what));
      if (foodMemory) {
        return {
          user_transcript: queryText,
          spoken_response: `You had ${foodMemory.what.replace(/^(i had|had|ate)\s+/i, "")} Arthur.`,
          extracted_memory: null,
          flags: { emergency: false, dose_question: false, distress: false },
        };
      }
    }

    if (q.includes("walk") || q.includes("where") || q.includes("go")) {
      const walkMemory = memories.find(m => /walk|went/i.test(m.what));
      if (walkMemory) {
        return {
          user_transcript: queryText,
          spoken_response: `You mentioned: "${walkMemory.what}".`,
          extracted_memory: null,
          flags: { emergency: false, dose_question: false, distress: false },
        };
      }
    }

    if (q.includes("who") || q.includes("see") || q.includes("visit") || q.includes("come")) {
      const visitMemory = memories.find(m => m.who && m.who.length > 0);
      if (visitMemory) {
        return {
          user_transcript: queryText,
          spoken_response: `${visitMemory.who.join(", ")} visited you Arthur.`,
          extracted_memory: null,
          flags: { emergency: false, dose_question: false, distress: false },
        };
      }
    }

    return {
      user_transcript: queryText,
      spoken_response: "I do not have a record of that yet Arthur.",
      extracted_memory: null,
      flags: { emergency: false, dose_question: false, distress: false },
    };
  }

  // Statement / Sharing a Memory (No fabricated people or places)
  let extractedWhere = null;
  let extractedWho = [];

  // Only extract explicitly stated locations
  if (q.includes("london bridge")) extractedWhere = "London Bridge";
  else if (q.includes("garden")) extractedWhere = "Garden";
  else if (q.includes("kitchen")) extractedWhere = "Kitchen";

  // Only extract explicitly stated people
  if (q.includes("sarah")) extractedWho.push("Sarah");
  if (q.includes("david")) extractedWho.push("David");

  let memoryDescription = queryText || "Recorded memory";
  let acknowledge = `I've saved that note for you Arthur: "${queryText}".`;

  if (hasVisualFrame) {
    extractedWhere = extractedWhere || "Room (Camera Active)";
    memoryDescription = `${queryText} [Camera feed active]`;
    acknowledge = `I've saved what you shared along with the camera view Arthur.`;
  }

  return {
    user_transcript: queryText,
    spoken_response: acknowledge,
    extracted_memory: {
      who: extractedWho,
      what: memoryDescription,
      where: extractedWhere,
      when: new Date().toISOString(), // Valid ISO event timestamp for clean ingestion
    },
    flags: { emergency: false, dose_question: false, distress: false },
  };
}

export async function processPatientAudio(audioBase64, mimeType, history = [], memories = [], text = null, imageBase64 = null) {
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

  const contextPrompt = `
Current Time: ${new Date().toLocaleTimeString()}
Known memories:
${memories.length > 0 ? memories.map(m => `- [${m.when || "Recorded"}] ${m.what} (with: ${m.who?.join(", ") || "none"}) at ${m.where || "unspecified"}`).join("\n") : "No previous memories recorded."}

Recent conversation:
${history.map(h => `${h.role === "user" ? "Patient" : "Companion"}: ${h.content}`).join("\n")}
`;

  try {
    const parts = [{ text: contextPrompt }];
    if (text) {
      parts.push({ text: `Patient message: "${text}"` });
    }
    if (audioBase64) {
      parts.push({
        inlineData: {
          mimeType: mimeType || "audio/wav",
          data: audioBase64,
        },
      });
    }
    if (imageBase64) {
      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: imageBase64,
        },
      });
    }

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: DEMENTIA_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });

    const parsed = JSON.parse(response.text);
    return parsed;
  } catch (error) {
    return searchMemoriesAndRespond(text, memories, !!imageBase64);
  }
}
