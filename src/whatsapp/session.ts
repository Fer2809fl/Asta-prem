import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
} from "baileysx";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

// Mismo patrón que src/core/subbot.ts en el proyecto principal: se
// reutiliza deliberadamente (useMultiFileAuthState, fetchLatestBaileysVersion,
// el mismo manejo de DisconnectReason y el mismo límite/backoff de
// reintentos) para no duplicar una implementación de WhatsApp ya probada.
// La diferencia es que aquí solo existe UN Sub-Bot por proceso -el del
// dispositivo Termux donde corre- en vez de un Map de muchos.

const wsLogger = pino({ level: "silent" });

export type ConnectionStatus = "connecting" | "waiting_qr" | "waiting_pairing" | "open" | "close" | "logged_out";

export interface WhatsAppSessionEvents {
  onStatus: (status: ConnectionStatus, extra?: { phoneNumber?: string }) => void;
  onPairingCode?: (code: string) => void;
}

let sock: any = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

export async function stopWhatsAppSession(): Promise<void> {
  stopped = true;
  clearReconnectTimer();
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.ws?.close();
      try {
        sock.end(new Error("stopped"));
      } catch {
        /* noop */
      }
    } catch {
      /* noop */
    }
  }
  sock = null;
}

export function hasValidCreds(): boolean {
  try {
    const credsPath = path.join(config.sessionDir, "creds.json");
    if (!fs.existsSync(credsPath)) return false;
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    return !!creds?.me?.id;
  } catch {
    return false;
  }
}

export async function startWhatsAppSession(events: WhatsAppSessionEvents): Promise<void> {
  stopped = false;
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: wsLogger,
    browser: Browsers.macOS("Chrome"),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  // Código de vinculación (recomendado: no requiere escanear nada, solo
  // teclear un código de 8 caracteres en el celular).
  if (config.loginMethod === "pairing" && !state.creds.registered) {
    if (!config.phoneNumber) {
      throw new Error(
        "LOGIN_METHOD=pairing requiere PHONE_NUMBER en .env (con código de país, sin '+', sin espacios)."
      );
    }
    events.onStatus("waiting_pairing");
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(config.phoneNumber);
        logger.ok(`Código de vinculación de WhatsApp: ${code}`);
        logger.info("Abre WhatsApp → Dispositivos vinculados → Vincular con número de teléfono, e ingresa ese código.");
        events.onPairingCode?.(code);
      } catch (err) {
        logger.error("No se pudo solicitar el código de vinculación:", err);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async (update: any) => {
    const { connection, lastDisconnect, qr } = update;

    // Método QR (alternativa si el celular no admite código de vinculación).
    if (qr && config.loginMethod === "qr") {
      events.onStatus("waiting_qr");
      logger.info("Escanea este código QR desde WhatsApp → Dispositivos vinculados:");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "open") {
      reconnectAttempts = 0;
      const phoneNumber = (sock.user?.id as string | undefined)?.split(":")[0]?.split("@")[0];
      logger.ok(`WhatsApp conectado${phoneNumber ? ` (${phoneNumber})` : ""}.`);
      events.onStatus("open", { phoneNumber });
    }

    if (connection === "close") {
      const err = lastDisconnect?.error as Boom | undefined;
      const statusCode = err?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isCorrupted = statusCode === 406 || String(err?.message ?? "").includes("not-acceptable");

      events.onStatus("close");

      if (stopped) return;

      if (isLoggedOut || isCorrupted) {
        logger.warn(
          isLoggedOut
            ? "Sesión cerrada desde el celular (logout). Hay que vincular de nuevo."
            : "Sesión corrupta detectada (406). Hay que vincular de nuevo."
        );
        events.onStatus("logged_out");
        return;
      }

      reconnectAttempts += 1;
      if (reconnectAttempts > config.maxReconnectAttempts) {
        logger.error(`Se alcanzó el máximo de ${config.maxReconnectAttempts} reintentos. Deteniendo reconexión automática.`);
        return;
      }

      logger.warn(`Conexión perdida. Reintento ${reconnectAttempts}/${config.maxReconnectAttempts}...`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWhatsAppSession(events).catch((e) => logger.error("Error reconectando:", e));
      }, config.reconnectDelayMs);
    }
  });
}
