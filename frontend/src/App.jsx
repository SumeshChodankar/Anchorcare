import React, { useState, useEffect, useRef } from "react";
import { socket } from "./services/socket";
import { Mic, MicOff, Volume2, ShieldAlert, UserCheck, Stethoscope, Video, VideoOff, Send } from "lucide-react";
import CaregiverPortal from "./CaregiverPortal";
import "./App.css";

export default function App() {
  const [patientId] = useState("arthur_01");
  const [view, setView] = useState("patient");
  const [active, setActive] = useState(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Tap 'Start Voice' or 'Start Video' to begin");
  const [messages, setMessages] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [isBotSpeaking, setIsBotSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);

  const [textInput, setTextInput] = useState("");
  const [videoActive, setVideoActive] = useState(false);

  const audioPlayerRef = useRef(new Audio());
  const activeRef = useRef(false);
  const videoActiveRef = useRef(false);
  const isBotSpeakingRef = useRef(false);
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const recognitionRef = useRef(null);
  // Accumulated full transcript spanning multiple sentences and pauses
  const accumulatedTranscriptRef = useRef("");

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    videoActiveRef.current = videoActive;
  }, [videoActive]);

  useEffect(() => {
    isBotSpeakingRef.current = isBotSpeaking;
  }, [isBotSpeaking]);

  const getCameraSnapshotBase64 = () => {
    if (videoActiveRef.current && videoRef.current && videoRef.current.videoWidth > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 300;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(videoRef.current, 0, 0, 400, 300);
      return canvas.toDataURL("image/jpeg", 0.6).split(",")[1];
    }
    return null;
  };

  const startAudioCapture = async () => {
    try {
      accumulatedTranscriptRef.current = "";

      // Continuous Speech-To-Text across multiple sentences and pauses
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        const reco = new SpeechRecognition();
        reco.continuous = true;
        reco.interimResults = true;
        reco.lang = "en-US";

        reco.onresult = (e) => {
          let currentSessionText = "";
          for (let i = 0; i < e.results.length; ++i) {
            currentSessionText += e.results[i][0].transcript + " ";
          }
          currentSessionText = currentSessionText.trim();

          if (currentSessionText) {
            accumulatedTranscriptRef.current = currentSessionText;
            setStatus(`Hearing: "${currentSessionText}"`);
          }
        };

        // If the browser temporarily cuts recognition on a pause, auto-restart it seamlessly while listening is active!
        reco.onend = () => {
          if (activeRef.current) {
            try {
              reco.start();
            } catch (_) {}
          }
        };

        try {
          reco.start();
          recognitionRef.current = reco;
        } catch (_) {}
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        if (audioChunksRef.current.length > 0) {
          const blob = new Blob(audioChunksRef.current, { type: "audio/wav" });
          audioChunksRef.current = [];
          setStatus("Thinking and remembering...");

          const isCamOn = videoActiveRef.current;
          const currentVisual = isCamOn ? getCameraSnapshotBase64() : null;
          const fullSentences = accumulatedTranscriptRef.current.trim();

          socket.emit("patient_audio", {
            patientId,
            audioBuffer: blob,
            transcript: fullSentences || null,
            imageBase64: currentVisual,
            cameraIsActive: isCamOn,
            timestamp: new Date().toISOString(),
          });

          accumulatedTranscriptRef.current = "";
        }
      };

      recorder.start(250);
      setIsUserSpeaking(true);
      setActive(true);
      setStatus("Listening to your voice... Speak all your thoughts freely.");
    } catch (err) {
      console.error("Audio error:", err);
      setStatus("Microphone permission needed. You can still type below!");
    }
  };

  const stopAudioCapture = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null; // Prevent restart
        recognitionRef.current.stop();
      } catch (_) {}
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    setIsUserSpeaking(false);
    setActive(false);
  };

  const toggleVideoStream = async () => {
    if (videoActive) {
      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      }
      setVideoActive(false);
      videoActiveRef.current = false;
      stopAudioCapture();
      setStatus("Camera and microphone turned off.");
    } else {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 400, height: 300 } });
        if (videoRef.current) {
          videoRef.current.srcObject = camStream;
          videoRef.current.play();
        }
        setVideoActive(true);
        videoActiveRef.current = true;

        await startAudioCapture();
        setStatus("Camera & Microphone active. Speak all your thoughts freely.");
      } catch (e) {
        console.error("Camera access error:", e);
        alert("Camera permission denied or camera not available.");
      }
    }
  };

  const handleSendText = (e) => {
    e.preventDefault();
    if (!textInput.trim()) return;

    setStatus("Thinking...");
    socket.emit("patient_text", {
      patientId,
      text: textInput.trim(),
    });
    setTextInput("");
  };

  useEffect(() => {
    socket.on("connect", () => {
      setConnected(true);
      socket.emit("join_session", { patientId });
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    socket.on("conversation_update", (data) => {
      setMessages((prev) => [...prev.slice(-8), data]);
      setStatus("I am listening. You can speak, type, or show me on video.");
    });

    socket.on("audio_response", (data) => {
      if (data?.audioBase64) {
        setIsBotSpeaking(true);
        setStatus("Companion is speaking...");

        const audioSrc = `data:audio/mp3;base64,${data.audioBase64}`;
        audioPlayerRef.current.src = audioSrc;
        audioPlayerRef.current.play().catch(console.error);

        audioPlayerRef.current.onended = () => {
          setIsBotSpeaking(false);
          setStatus("I am listening. You can speak, type, or show me on video.");
        };
      }
    });

    socket.on("alert_triggered", (alert) => {
      setAlerts((prev) => [alert, ...prev.slice(0, 4)]);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("conversation_update");
      socket.off("audio_response");
      socket.off("alert_triggered");
      stopAudioCapture();
    };
  }, [patientId]);

  const toggleCompanion = async () => {
    if (active) {
      stopAudioCapture();
      setStatus("Voice listening paused.");
    } else {
      await startAudioCapture();
    }
  };

  if (view === "caregiver") {
    return <CaregiverPortal onBack={() => setView("patient")} />;
  }

  return (
    <div className="container">
      <header className="header">
        <div className="status-badge">
          <span className={`status-dot ${connected ? "online" : "offline"}`} />
          {connected ? "Server Connected" : "Connecting..."}
        </div>
        <button className="view-switch-btn" onClick={() => setView("caregiver")}>
          <Stethoscope size={16} /> Caregiver Portal
        </button>
      </header>

      <main className="main-content">
        <div className="multimodal-row">
          <div
            className={`orb-wrapper ${
              active
                ? isUserSpeaking
                  ? "user-speaking"
                  : isBotSpeaking
                  ? "bot-speaking"
                  : "active"
                : "inactive"
            }`}
            onClick={toggleCompanion}
            style={{ cursor: "pointer" }}
          >
            <div className="orb-circle">
              {isBotSpeaking ? (
                <Volume2 size={56} className="pulse-icon" />
              ) : active ? (
                <Mic size={56} className="pulse-icon" />
              ) : (
                <MicOff size={56} />
              )}
            </div>
          </div>

          <div className="video-card">
            <video ref={videoRef} className={`live-video ${videoActive ? "visible" : "hidden"}`} playsInline muted />
            <button
              className={`camera-toggle-btn ${videoActive ? "active" : ""}`}
              onClick={toggleVideoStream}
            >
              {videoActive ? <VideoOff size={18} /> : <Video size={18} />}
              <span>{videoActive ? "Stop Camera" : "🎥 Start Video & Audio"}</span>
            </button>
          </div>
        </div>

        <h2 className="status-text">{status}</h2>

        <button
          className={`big-toggle-btn ${active ? "btn-stop" : "btn-start"}`}
          onClick={toggleCompanion}
        >
          {active ? "✓ Process What I Spoke / Pause Mic" : "🎙️ Start Voice Listening (Audio Only)"}
        </button>

        <form className="text-input-form" onSubmit={handleSendText}>
          <input
            type="text"
            placeholder="Type anything here (e.g. 'Sarah brought soup')..."
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
          />
          <button type="submit" className="send-btn">
            <Send size={18} />
          </button>
        </form>

        <section className="transcript-section">
          <h3>Recent Conversation</h3>
          <div className="transcript-feed">
            {messages.length === 0 ? (
              <p className="empty-text">No conversation yet. Tap 'Start Voice Listening' or 'Start Video' to begin!</p>
            ) : (
              messages.map((m, idx) => (
                <div key={idx} className={`message-bubble ${m.sender}`}>
                  <span className="sender-label">
                    {m.sender === "patient" ? "Arthur" : "Engram"}:
                  </span>
                  <p>{m.text}</p>
                </div>
              ))
            )}
          </div>
        </section>

        {alerts.length > 0 && (
          <section className="alerts-section">
            <div className="alert-header">
              <ShieldAlert size={20} color="#e53e3e" />
              <h4>Doctor & Caregiver Notifications</h4>
            </div>
            <div className="alert-list">
              {alerts.map((a, i) => (
                <div key={i} className="alert-card">
                  <span className="alert-type">{a.type}</span>
                  <p>{a.message}</p>
                  <small>{new Date(a.time).toLocaleTimeString()}</small>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
