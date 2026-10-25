import { io } from "socket.io-client";

// Connect to the Node.js backend (default localhost:5000)
export const socket = io(import.meta.env.VITE_BACKEND_URL || "http://localhost:5000", {
  autoConnect: true,
  transports: ["websocket", "polling"],
});
