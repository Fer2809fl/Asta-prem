import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

// Carga .env manualmente (sin dependencia extra de dotenv: el runtime
// debe tener el menor número de dependencias posible para instalar rápido
// en Termux con conexiones lentas).
function loadEnvFile(): void {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

// ─── Discovery automático ───────────────────────────────────────────
//
// La URL oficial de la API central está codificada aquí como fallback
// único y exclusivo. NO es un secreto: es un endpoint público que el
// usuario del Sub-Bot puede ver sin riesgo (solo expone metadata no
// sensible — ver /api/subbot/v1/discover en el servidor).
//
// Si el usuario definió API_BASE_URL en .env (avanzado), se usa esa.
// Si no, se usa el valor oficial por defecto. La API base nunca incluye
// credenciales: la autenticación del runtime se hace con el token
// generado automáticamente al registrarse (ver api/client.ts).
const DEFAULT_API_BASE_URL = "https://astabot.hidenplay.net";

function resolveApiBaseUrl(): string {
  const fromEnv = (process.env.API_BASE_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return DEFAULT_API_BASE_URL.replace(/\/+$/, "");
}

export const config = {
  rootDir: ROOT_DIR,
  dataDir: path.join(ROOT_DIR, "data"),
  stateFile: path.join(ROOT_DIR, "data", "runtime-state.json"),
  sessionDir: path.join(ROOT_DIR, "data", "session"),
  backupDir: path.join(ROOT_DIR, "data", "backup"),

  // URL base de la API central. Se resuelve en este orden:
  //   1. Variable de entorno API_BASE_URL (si el usuario la definió manualmente)
  //   2. Default oficial (público, no sensible)
  apiBaseUrl: resolveApiBaseUrl(),

  // Nombre visible del Sub-Bot. El usuario lo define en .env. Si no,
  // se genera uno basado en hostname/fecha. Esto es lo ÚNICO que el
  // usuario realmente necesita configurar.
  botName: (process.env.BOT_NAME || "").trim() || `AstaBot-${require("node:os").hostname().slice(0, 12)}`,

  // "pairing" (código de 8 dígitos) o "qr" (imagen ASCII en terminal).
  loginMethod: (process.env.LOGIN_METHOD || "pairing").toLowerCase(),

  // Número de teléfono con código de país, sin +, sin espacios (solo si loginMethod=pairing).
  phoneNumber: process.env.PHONE_NUMBER || "",

  // Cada cuánto se reporta estado/heartbeat a la API (ms).
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS || 60_000),

  // Cada cuánto se consulta si hay una actualización disponible (ms).
  updateCheckIntervalMs: Number(process.env.UPDATE_CHECK_INTERVAL_MS || 6 * 60 * 60 * 1000),

  // Cada cuánto se sincronizan comandos/flows desde la API (ms).
  // Default: 5 minutos. El runtime también puede recibir push via WebSocket.
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 5 * 60 * 1000),

  // Nombre de componente bajo el que este runtime se reporta en /updates.
  componentName: "termux-runtime",

  runtimeVersion: JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf-8")
  ).version as string,

  maxReconnectAttempts: 5,
  reconnectDelayMs: 5000,
};

// Crea los directorios de datos si no existen. La carpeta data/ está en
// .gitignore (ver .gitignore del runtime) — el estado del runtime,
// las sesiones de WhatsApp y los backups viven ahí, nunca en el repo.
for (const dir of [config.dataDir, config.sessionDir, config.backupDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
