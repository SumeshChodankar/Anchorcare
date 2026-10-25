import React, { useState, useEffect } from "react";
import { socket } from "./services/socket";
import { ShieldAlert, Heart, Calendar, Clock, User, ArrowLeft, RefreshCw } from "lucide-react";
import "./App.css";

export default function CaregiverPortal({ onBack }) {
  const [patientId] = useState("arthur_01");
  const [memories, setMemories] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchCaregiverData = async () => {
    try {
      setLoading(true);
      const res = await fetch(`http://localhost:5000/api/caregiver/${patientId}`);
      const data = await res.json();
      setMemories(data.memories || []);
      setAlerts(data.alerts || []);
    } catch (err) {
      console.error("Caregiver fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCaregiverData();

    socket.on("alert_triggered", (newAlert) => {
      setAlerts((prev) => [newAlert, ...prev]);
    });

    return () => {
      socket.off("alert_triggered");
    };
  }, [patientId]);

  return (
    <div className="container caregiver-portal">
      <header className="header">
        <button className="back-btn" onClick={onBack}>
          <ArrowLeft size={18} /> Back to Companion
        </button>
        <div className="patient-tag">
          <User size={18} />
          <span>Patient: Arthur (Caregiver View)</span>
        </div>
      </header>

      <main className="portal-content">
        <div className="portal-title-row">
          <h2>🩺 Doctor & Caregiver Live Feed</h2>
          <button className="refresh-btn" onClick={fetchCaregiverData}>
            <RefreshCw size={16} /> Refresh
          </button>
        </div>

        {/* Priority Alerts Section */}
        <section className="alerts-card-section">
          <h3>
            <ShieldAlert size={20} color="#e53e3e" /> Critical Safety Notifications
          </h3>
          {alerts.length === 0 ? (
            <div className="no-data-card">No safety alerts recorded. Arthur is resting comfortably.</div>
          ) : (
            alerts.map((alert, i) => (
              <div key={i} className={`alert-item-card ${alert.type.toLowerCase()}`}>
                <div className="alert-meta">
                  <span className="badge">{alert.type}</span>
                  <small>{new Date(alert.timestamp || alert.time).toLocaleTimeString()}</small>
                </div>
                <p className="alert-text">{alert.message}</p>
              </div>
            ))
          )}
        </section>

        {/* Daily Memories & Episode Timeline */}
        <section className="memories-timeline-section">
          <h3>
            <Calendar size={20} color="#3182ce" /> Stored Memory Bank (MongoDB Atlas)
          </h3>
          {loading ? (
            <p>Loading patient records...</p>
          ) : memories.length === 0 ? (
            <div className="no-data-card">No memories recorded yet today.</div>
          ) : (
            <div className="timeline-feed">
              {memories.map((m, idx) => (
                <div key={idx} className="memory-card">
                  <div className="memory-time">
                    <Clock size={14} />
                    <span>{m.when || new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <div className="memory-body">
                    <h4>{m.what}</h4>
                    {m.who && m.who.length > 0 && (
                      <p className="sub-text">
                        <strong>People:</strong> {m.who.join(", ")}
                      </p>
                    )}
                    {m.where && (
                      <p className="sub-text">
                        <strong>Location:</strong> {m.where}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
