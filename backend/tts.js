// Simple helper using Google Translate TTS endpoint for rapid zero-cost speech synthesis
// For production or Cloud TTS, you can swap this with @google-cloud/text-to-speech
import https from "https";

export async function synthesizeSpeechBase64(text) {
  if (!text) return null;

  const encodedText = encodeURIComponent(text);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=en&client=tw-ob`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString("base64"));
      });
      res.on("error", (err) => {
        console.error("TTS fetch error:", err);
        resolve(null);
      });
    }).on("error", (err) => {
      console.error("TTS request error:", err);
      resolve(null);
    });
  });
}
