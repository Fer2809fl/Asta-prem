import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { loadState, saveState, clearState } from "./util/state.js";
import { SubBotApiClient, ApiAuthError, logApiIssue } from "./api/client.js";
import { startWhatsAppSession, stopWhatsAppSession, hasValidCreds } from "./whatsapp/session.js";
import { checkForUpdate, applyUpdate } from "./update.js";
import { startSyncLoop } from "./sync.js";

const STATUS_POLL_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Descubre la API central automáticamente (si el .env no fija API_BASE_URL).
 * Llama al endpoint público /discover para confirmar reachability y
 * obtener metadata. Si el servidor devuelve una apiBaseUrl distinta (ej.
 * migración de dominio), el runtime la usa para este arranque.
 */
async function discoverApi(api: SubBotApiClient): Promise<SubBotApiClient> {
  try {
    const info = await api.discover();
    if (info.apiBaseUrl && info.apiBaseUrl !== config.apiBaseUrl) {
      logger.info(`Discovery: el servidor reporta API base ${info.apiBaseUrl} (default local: ${config.apiBaseUrl}). Usando la del servidor.`);
      return new SubBotApiClient(null, info.apiBaseUrl);
    }
    logger.ok(`Discovery OK — servidor ${info.serverVersion}, runtime esperado ${info.runtimeVersion}.`);
    return api;
  } catch (err) {
    // No fatal: el default público ya está fijado en config.ts. Si la red
    // está caída, register() fallará más abajo y se reportará claro.
    logger.warn(`Discovery no respondió en ${config.apiBaseUrl}/api/subbot/v1/discover — intentando con la URL por defecto.`);
    return api;
  }
}

async function ensureRegisteredAndLinked(api: SubBotApiClient): Promise<SubBotApiClient> {
  let state = loadState();

  // Paso 1: si todavía no hay botId/token, registrar el runtime contra la
  // API. El token se guarda una sola vez -la API no lo vuelve a mostrar.
  if (!state.botId || !state.token) {
    logger.info("Runtime sin registrar. Registrando contra la API central...");
    const result = await api.register(config.botName);
    state = {
      ...state,
      botId: result.botId,
      token: result.token,
      linkCode: result.linkCode,
      linkCodeExpiresAt: result.linkCodeExpiresAt,
      linked: false,
    };
    saveState(state);
    logger.ok(`Registrado. botId: ${result.botId}`);
    logger.info("Entra al panel web → Mis Sub-Bots → Vincular runtime, e ingresa este código:");
    logger.info(`     ${result.linkCode}     (vence en 10 minutos)`);
    // Si la API devuelve otra base URL, adoptarla para las siguientes llamadas.
    if (result.apiBaseUrl && result.apiBaseUrl !== config.apiBaseUrl) {
      logger.info(`Servidor indica nueva API base: ${result.apiBaseUrl}`);
      return new SubBotApiClient(null, result.apiBaseUrl);
    }
  }

  api.setToken(state.token);

  // Paso 2: esperar a que el usuario reclame este botId desde el panel
  // web pegando el linkCode (vence en 10 minutos desde el registro).
  if (!state.linked) {
    while (true) {
      try {
        const status = await api.getStatus();
        if (status.status !== "pending_link") {
          logger.ok(`Sub-Bot "${config.botName}" vinculado a tu cuenta del panel. Continuando...`);
          state.linked = true;
          state.linkCode = null;
          state.linkCodeExpiresAt = null;
          saveState(state);
          break;
        }
      } catch (err) {
        if (err instanceof ApiAuthError) throw err;
        logApiIssue(err);
      }

      if (state.linkCodeExpiresAt && Date.now() > new Date(state.linkCodeExpiresAt).getTime()) {
        logger.warn("El código de vinculación venció. Se generará uno nuevo...");
        clearState();
        // Recursión: registra de nuevo con un nuevo código.
        return ensureRegisteredAndLinked(api);
      }

      await sleep(STATUS_POLL_MS);
    }
  }

  return api;
}

async function runHeartbeatLoop(api: SubBotApiClient): Promise<void> {
  setInterval(async () => {
    try {
      await api.postStatus({ runtime_version: config.runtimeVersion });
    } catch (err) {
      if (err instanceof ApiAuthError) {
        logger.error("El token fue revocado o expiró. Deteniendo el runtime — hay que rotar el token desde el panel y ejecutar de nuevo.");
        await shutdown(1);
        return;
      }
      logApiIssue(err);
    }
  }, config.heartbeatIntervalMs);
}

async function runUpdateLoop(api: SubBotApiClient): Promise<void> {
  const check = async () => {
    try {
      const update = await checkForUpdate(api);
      if (update.available) {
        logger.info(`Actualización disponible: ${update.latestVersion}${update.notes ? ` — ${update.notes}` : ""}`);
        await applyUpdate(api);
      }
    } catch (err) {
      logApiIssue(err);
    }
  };
  await check();
  setInterval(check, config.updateCheckIntervalMs);
}

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Cerrando runtime...");
  await stopWhatsAppSession();
  process.exit(code);
}

async function main(): Promise<void> {
  logger.info(`Asta-Bot Termux Runtime v${config.runtimeVersion}`);
  logger.info(`Bot: ${config.botName}`);
  logger.info(`API central: ${config.apiBaseUrl}`);

  let api = new SubBotApiClient();

  try {
    // Discovery automático — no autenticado, no sensible.
    api = await discoverApi(api);
    api = await ensureRegisteredAndLinked(api);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      logger.error(`No se pudo completar el registro/vinculación: ${err.message}`);
    } else {
      logApiIssue(err);
    }
    process.exit(1);
  }

  const state = loadState();
  if (!hasValidCreds()) {
    logger.info(`Iniciando sesión de WhatsApp (método: ${config.loginMethod})...`);
  } else {
    logger.info("Sesión de WhatsApp existente encontrada. Reconectando...");
  }

  await startWhatsAppSession({
    onStatus: async (status, extra) => {
      if (status === "open") {
        try {
          await api.postStatus({
            is_linked: true,
            phone_number: extra?.phoneNumber,
            runtime_version: config.runtimeVersion,
          });
        } catch (err) {
          logApiIssue(err);
        }
      }
      if (status === "close" || status === "logged_out") {
        try {
          await api.postStatus({ is_linked: false });
        } catch (err) {
          logApiIssue(err);
        }
      }
      if (status === "logged_out") {
        const fresh = loadState();
        fresh.phoneNumber = null;
        saveState(fresh);
      }
    },
  });

  await runHeartbeatLoop(api);
  await runUpdateLoop(api);

  // Bucle de sincronización de recursos: comandos custom, flows,
  // metadatos de actualizaciones. El runtime descarga lo que le
  // pertenece (el servidor filtra por req.subbot.id).
  startSyncLoop(api);

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("uncaughtException", (err) => {
    logger.error("Excepción no capturada:", err);
  });
  process.on("unhandledRejection", (err) => {
    logger.error("Rechazo de promesa no capturado:", err);
  });
}

main().catch((err) => {
  logger.error("Error fatal iniciando el runtime:", err);
  process.exit(1);
});
