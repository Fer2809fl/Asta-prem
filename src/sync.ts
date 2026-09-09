import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { SubBotApiClient, ApiAuthError, logApiIssue } from "./api/client.js";
import { loadState, saveState } from "./util/state.js";

// ─── Sincronización de recursos del Sub-Bot ──────────────────────────
//
// El runtime descarga periódicamente el "sync manifest" desde la API
// central. Ese manifest contiene:
//   - Comandos personalizados del dueño del Sub-Bot (response_content,
//     no código ejecutable directo: el runtime los interpreta como
//     respuestas simples o como flows).
//   - Flows completos (nodos + edges + variables) que el runtime
//     ejecuta localmente sin necesidad de código arbitrario.
//   - Metadatos (versiones) de comandos oficiales disponibles.
//
// Lo que NO se sincroniza automáticamente:
//   - Código TypeScript de comandos oficiales — el runtime descarga el
//     que el usuario activa explícitamente (ver getOfficialCommand).
//   - Tokens, secretos, cookies — el servidor nunca los incluye.
//   - Sesiones de WhatsApp — viven solo en el dispositivo del usuario.
//
// Todo se persiste en data/runtime-resources.json (gitignored) para que
// el runtime pueda seguir funcionando sin conexión a la API.

const RESOURCES_FILE = path.join(config.dataDir, "runtime-resources.json");

interface LocalResources {
  commands: any[];
  flows: any[];
  official_commands_version: string;
  config_version: string;
  last_synced_at: string | null;
}

function loadLocalResources(): LocalResources {
  try {
    if (fs.existsSync(RESOURCES_FILE)) {
      return JSON.parse(fs.readFileSync(RESOURCES_FILE, "utf-8"));
    }
  } catch {
    /* si está corrupto, lo regeneramos */
  }
  return { commands: [], flows: [], official_commands_version: "", config_version: "", last_synced_at: null };
}

function saveLocalResources(r: LocalResources): void {
  fs.writeFileSync(RESOURCES_FILE, JSON.stringify(r, null, 2));
}

export function getLocalResources(): LocalResources {
  return loadLocalResources();
}

export async function syncNow(api: SubBotApiClient): Promise<{ ok: boolean; counts: { commands: number; flows: number } }> {
  try {
    const manifest = await api.getSyncManifest();
    const local = loadLocalResources();
    local.commands = manifest.commands;
    local.flows = manifest.flows;
    local.official_commands_version = manifest.official_commands_version;
    local.config_version = manifest.config_version;
    local.last_synced_at = new Date().toISOString();
    saveLocalResources(local);
    logger.ok(`Sincronización: ${manifest.commands.length} comandos, ${manifest.flows.length} flows.`);
    return { ok: true, counts: { commands: manifest.commands.length, flows: manifest.flows.length } };
  } catch (err) {
    if (err instanceof ApiAuthError) {
      logger.error(`Sincronización rechazada por autenticación: ${err.message}`);
    } else {
      logApiIssue(err);
    }
    return { ok: false, counts: { commands: 0, flows: 0 } };
  }
}

/**
 * Bucle de sincronización periódica. El runtime también puede recibir
 * un push via WebSocket desde el panel ("subbot:sync" event) para
 * sincronizar inmediatamente cuando el usuario guarda un cambio.
 */
export function startSyncLoop(api: SubBotApiClient): void {
  // Primera sincronización inmediata (después de que WhatsApp conecta).
  setTimeout(() => { syncNow(api).catch(() => {}); }, 5000).unref();

  // unref() permite que el proceso termine limpio si este timer es lo
  // único que queda pendiente (ej: durante shutdown). Sin unref, este
  // intervalo mantendría el proceso vivo aunque se llame a shutdown().
  setInterval(() => { syncNow(api).catch(() => {}); }, config.syncIntervalMs).unref();
}
