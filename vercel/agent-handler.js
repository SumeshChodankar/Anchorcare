// The voice agent (agent/daemon.js) as a Vercel function. Importing the daemon boots it
// (connects to Atlas, loads memory and the enrolled voice); in hosted mode it then
// serves requests through `handler` instead of listening on 127.0.0.1:4319.
import { handler } from "../agent/daemon.js";

export default handler;
