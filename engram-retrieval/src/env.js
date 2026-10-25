import { existsSync } from "node:fs";
import dns from "node:dns";
if (existsSync(".env")) process.loadEnvFile(".env");
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {}
