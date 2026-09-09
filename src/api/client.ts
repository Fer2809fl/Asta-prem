import axios, { AxiosInstance, AxiosError } from "axios";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

export class ApiAuthError extends Error {}
export class ApiError extends Error {}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  warning?: string;
}

export interface RegisterResult {
  botId: string;
  linkCode: string;
  linkCodeExpiresAt: string;
  token: string;
  apiBaseUrl?: string;
}

export interface StatusResult {
  status: string;
  is_linked: boolean;
  phone_number: string | null;
  last_seen_at: string | null;
}

export interface ConfigResult {
  name: string;
  prefix: string;
  logo_url: string | null;
}

export interface UpdateInfo {
  name: string;
  currentVersion: string | null;
  latestVersion: string;
  updateAvailable: boolean | null;
  notes: string | null;
}

export interface ComponentDownloadInfo {
  name: string;
  version: string;
  url: string;
  checksum: string | null;
}

// ─── Recursos sincronizables desde el servidor ──────────────────────
// Estos tipos representan los recursos que el runtime descarga del
// servidor para ejecutar localmente. Todos vienen SIN secretos: el
// servidor los filtra en la capa de DB antes de responder (ver
// src/web/db/database.ts -> serialize*ForRuntime).

export interface OfficialCommandInfo {
  name: string;
  description: string;
  category: string;
  version: string;
  code: string;
  checksum: string;
}

export interface CustomCommandInfo {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  response_type: "text" | "image" | "flow";
  response_content: string;
  is_active: boolean;
  updated_at: string;
}

export interface FlowInfo {
  id: string;
  name: string;
  description: string;
  nodes: any[];
  edges: any[];
  variables: Record<string, string>;
  permissions: string;
  updated_at: string;
}

export interface MarketplaceResourceInfo {
  id: string;
  name: string;
  description: string;
  author_name: string;
  version: string;
  type: "command" | "flow" | "plugin";
  category: string;
  permissions: string[];
  dependencies: string[];
  min_system_version: string;
  checksum: string | null;
  install_count: number;
}

export interface SyncManifest {
  commands: CustomCommandInfo[];
  flows: FlowInfo[];
  official_commands_version: string;
  config_version: string;
  last_synced_at: string;
}

/**
 * Cliente HTTP del runtime contra la API central de Asta-Bot.
 *
 * Reglas de diseño:
 *   1) Nunca incluye credenciales en la URL — todo va por header
 *      x-subbot-token (ver requireSubBotToken en el servidor).
 *   2) El token se guarda una sola vez al registrar el runtime, y se
 *      persiste en data/runtime-state.json (que está gitignored).
 *   3) Todas las llamadas autenticadas operan SOBRE el Sub-Bot dueño
 *      del token: el servidor nunca acepta un subbotId por body/query
 *      para decidir sobre qué fila actuar (ver subbotApi.ts).
 */
export class SubBotApiClient {
  private http: AxiosInstance;
  private token: string | null;

  constructor(token: string | null = null, baseUrlOverride?: string) {
    this.token = token;
    const baseURL = (baseUrlOverride || config.apiBaseUrl) + "/api/subbot/v1";
    this.http = axios.create({
      baseURL,
      timeout: 15_000,
      headers: { "Content-Type": "application/json" },
    });
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) throw new ApiError("No hay token de runtime cargado todavía.");
    return { "x-subbot-token": this.token };
  }

  private async unwrap<T>(promise: Promise<{ data: ApiEnvelope<T> }>): Promise<T> {
    try {
      const res = await promise;
      if (!res.data.success) {
        throw new ApiError(res.data.error || "La API respondió con un error sin detalle.");
      }
      return res.data.data as T;
    } catch (err) {
      const ax = err as AxiosError<ApiEnvelope<unknown>>;
      if (ax.isAxiosError) {
        const status = ax.response?.status;
        const apiMsg = ax.response?.data?.error;
        if (status === 401 || status === 403) {
          throw new ApiAuthError(
            apiMsg || "Token de runtime inválido, revocado o expirado. Hay que re-vincular el Sub-Bot."
          );
        }
        if (status === 429) {
          throw new ApiError(apiMsg || "La API está limitando la frecuencia de solicitudes (rate limit).");
        }
        throw new ApiError(apiMsg || ax.message);
      }
      throw err;
    }
  }

  /**
   * Discover público: obtén metadata no sensible sobre la API central.
   * No requiere autenticación. Lo usa el runtime en el primer arranque
   * para confirmar que el endpoint es alcanzable y para detectar si el
   * servidor movió la URL base (en cuyo caso el discover devuelve la
   * nueva URL, y el runtime puede reconfigurarse).
   */
  async discover(): Promise<{ apiBaseUrl: string; runtimeVersion: string; serverVersion: string; instructions: string[] }> {
    return this.unwrap(this.http.get("/discover"));
  }

  /** Sin autenticación: crea un Sub-Bot pendiente y devuelve token + linkCode. */
  async register(name?: string): Promise<RegisterResult> {
    return this.unwrap(
      this.http.post("/register", {
        name: name || config.botName,
        runtime_version: config.runtimeVersion,
      })
    );
  }

  /** Info propia completa (requiere token). */
  async me(): Promise<Record<string, unknown>> {
    return this.unwrap(this.http.get("/me", { headers: this.authHeaders() }));
  }

  async getStatus(): Promise<StatusResult> {
    return this.unwrap(this.http.get("/status", { headers: this.authHeaders() }));
  }

  async postStatus(payload: {
    phone_number?: string;
    is_linked?: boolean;
    runtime_version?: string;
  }): Promise<void> {
    await this.unwrap(this.http.post("/status", payload, { headers: this.authHeaders() }));
  }

  async getConfig(): Promise<ConfigResult> {
    return this.unwrap(this.http.get("/config", { headers: this.authHeaders() }));
  }

  async setConfig(payload: { name?: string; prefix?: string }): Promise<ConfigResult> {
    return this.unwrap(this.http.post("/config", payload, { headers: this.authHeaders() }));
  }

  async getVersion(): Promise<{ runtime_version: string | null }> {
    return this.unwrap(this.http.get("/version", { headers: this.authHeaders() }));
  }

  async getUpdates(): Promise<UpdateInfo[]> {
    return this.unwrap(this.http.get("/updates", { headers: this.authHeaders() }));
  }

  async getComponents(): Promise<{ name: string; latest_version: string; notes: string | null }[]> {
    return this.unwrap(this.http.get("/components", { headers: this.authHeaders() }));
  }

  async getComponentDownload(name: string): Promise<ComponentDownloadInfo> {
    return this.unwrap(
      this.http.get(`/components/${encodeURIComponent(name)}/download`, { headers: this.authHeaders() })
    );
  }

  /**
   * Aplicar una actualización: el servidor anota el intento en audit_log
   * y devuelve el manifiesto del componente autorizado. El runtime sigue
   * siendo el que descarga el binario desde la URL firmada (con checksum).
   */
  async reportUpdateApplied(payload: { fromVersion: string; toVersion: string; success: boolean; error?: string }): Promise<void> {
    await this.unwrap(this.http.post("/updates/report", payload, { headers: this.authHeaders() }));
  }

  /**
   * Sincroniza recursos del Sub-Bot: comandos custom, flows y
   * metadatos de comandos oficiales. El runtime solo recibe lo que le
   * pertenece (el servidor filtra por req.subbot.id en cada llamada).
   */
  async getSyncManifest(): Promise<SyncManifest> {
    return this.unwrap(this.http.get("/sync", { headers: this.authHeaders() }));
  }

  /**
   * Obtiene el código de un comando oficial (lo ejecuta el runtime
   * localmente, sin acceso a secretos del servidor).
   */
  async getOfficialCommand(name: string): Promise<OfficialCommandInfo> {
    return this.unwrap(
      this.http.get(`/commands/official/${encodeURIComponent(name)}`, { headers: this.authHeaders() })
    );
  }

  /**
   * Obtiene la lista del marketplace accesible para este Sub-Bot
   * (con permisos y dependencias validados por el servidor).
   */
  async getMarketplace(): Promise<MarketplaceResourceInfo[]> {
    return this.unwrap(this.http.get("/marketplace", { headers: this.authHeaders() }));
  }

  async installMarketplaceResource(resourceId: string): Promise<{ ok: boolean; resource?: MarketplaceResourceInfo; error?: string }> {
    return this.unwrap(
      this.http.post(`/marketplace/${encodeURIComponent(resourceId)}/install`, {}, { headers: this.authHeaders() })
    );
  }

  /**
   * Log de actividad: lo usa el runtime para reportar comandos ejecutados,
   * errores, eventos. El servidor filtra info sensible antes de guardar.
   */
  async logActivity(payload: { type: string; command?: string; success: boolean; details?: string }): Promise<void> {
    try {
      await this.unwrap(this.http.post("/activity", payload, { headers: this.authHeaders() }));
    } catch (err) {
      // Los logs de actividad son best-effort: no deben romper el runtime.
      logger.warn("No se pudo reportar actividad a la API:", err);
    }
  }

  /**
   * Llama una función autorizada del servidor. Esta es la ÚNICA forma
   * en que el código del Sub-Bot puede ejecutar algo que requiera acceso
   * a recursos del servidor (base de datos global, otras APIs, etc.).
   * El servidor define un catálogo de funciones autorizadas (ver
   * src/web/security/authorizedFunctions.ts en el servidor).
   */
  async callAuthorizedFunction(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }> {
    return this.unwrap(
      this.http.post(`/functions/${encodeURIComponent(name)}`, args, { headers: this.authHeaders() })
    );
  }
}

export function logApiIssue(err: unknown): void {
  if (err instanceof ApiAuthError) {
    logger.error(`Autenticación rechazada por la API: ${err.message}`);
  } else if (err instanceof ApiError) {
    logger.error(`Error de API: ${err.message}`);
  } else {
    logger.error("Error de red hablando con la API central:", err);
  }
}
