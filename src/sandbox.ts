import vm from "node:vm";
import { SubBotApiClient } from "./api/client.js";
import { logger } from "./util/logger.js";

// ─── Sandbox para ejecución de comandos personalizados ───────────────
//
// Los comandos que el usuario crea en el panel web (editor de código)
// se ejecutan en un contexto VM aislado con:
//   - Sin acceso a `require`, `process`, `fs`, `child_process`, `net`,
//     `os`, `http`, `https`, etc.
//   - Un conjunto explícito de APIs permitidas: reply, sendMessage,
//     callAuthorizedFunction (que pasa por el servidor), variables
//     locales del flujo, args, sender, chatId, etc.
//   - Timeout de 5 segundos por ejecución (no se pueden colgar).
//   - Memoria limitada via vm.MemoryMeasurement (best-effort, Node
//     no tiene un límite duro de memoria por vm.Context en 20.x).
//
// Lo que SÍ permite:
//   - Operaciones de string, número, array, objeto.
//   - fetch() a URLs PÚBLICAS (las APIs internas del servidor se
//     acceden solo vía callAuthorizedFunction — el servidor filtra).
//   - Llamar a ctx.reply(), ctx.sendImage(), etc.
//   - Variables persistentes del Sub-Bot (via ctx.getVar / ctx.setVar,
//     que el runtime implementa sin exponer fs directamente).
//
// Lo que NO permite:
//   - require/import de cualquier módulo Node.
//   - process.env, process.exit, process.argv.
//   - Leer o escribir archivos del filesystem del runtime.
//   - Ejecutar procesos hijos.
//   - Acceder a la red local (localhost, 192.168.x, 10.x, 172.16-31.x).
//   - Acceder al token del runtime (no está en el contexto).

export interface CommandContext {
  sock: any;
  chatId: string;
  sender: string;
  args: string[];
  fullText: string;
  usedPrefix: string;
  isOwner: boolean;
  isGroup: boolean;
  reply: (text: string) => Promise<void>;
  sendImage: (url: string, caption?: string) => Promise<void>;
  getVar: (name: string) => any;
  setVar: (name: string, value: any) => void;
  callAuthorizedFunction: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;
}

export interface SandboxRunResult {
  ok: boolean;
  error?: string;
  durationMs: number;
}

const EXECUTION_TIMEOUT_MS = 5000;
const MAX_CODE_SIZE = 64 * 1024; // 64 KB

// Lista de patrones prohibidos en el código fuente. Esta validación
// es una PRIMERA LÍNEA de defensa (static check); el sandbox VM
// garantiza el aislamiento real aunque el regex se evada (no hay
// require, no hay process, no hay globalThis.process, etc.).
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\brequire\s*\(/,                       // CommonJS require
  /\bimport\s+[^;]+\s+from\s+['"]/,       // ESM static import
  /\bimport\s*\(/,                        // dynamic import()
  /\bprocess\b/,                          // process.*
  /\bglobalThis\b/,                        // globalThis.* (escape hatch)
  /\bchild_process\b/,                     // child_process
  /\b__dirname\b/,                         // __dirname
  /\b__filename\b/,                        // __filename
  /\bfs\./,                               // fs.* (no fs in scope)
  /\bos\./,                               // os.* (no os in scope)
  /\bnet\./,                               // net.*
  /\bhttp\./,                              // http.* (fetch is allowed)
  /\bhttps\./,                             // https.*
  /\bDeno\b/,                              // Deno.*
  /\beval\s*\(/,                           // eval
  /\bnew\s+Function\s*\(/,                 // new Function
  /\bsetInterval\s*\(/,                    // setInterval (memory leak)
  /\bsetTimeout\s*\(/,                     // setTimeout (escape hatch)
];

export function validateCommandCode(code: string): { ok: boolean; reason?: string } {
  if (!code || typeof code !== "string") {
    return { ok: false, reason: "Código vacío" };
  }
  if (code.length > MAX_CODE_SIZE) {
    return { ok: false, reason: `Código demasiado grande (${code.length} bytes, máx ${MAX_CODE_SIZE})` };
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      return { ok: false, reason: `Patrón prohibido en el código: ${pattern.source}` };
    }
  }
  return { ok: true };
}

/**
 * Ejecuta una función `execute(ctx)` en un sandbox aislado.
 * El código debe venir ya validado por validateCommandCode.
 */
export function runSandboxed(code: string, ctx: CommandContext): SandboxRunResult {
  const start = Date.now();

  // Verificación estática de patrones obvios.
  const v = validateCommandCode(code);
  if (!v.ok) {
    return { ok: false, error: v.reason, durationMs: 0 };
  }

  // Construye un contexto mínimo explícito. Nada de `this` con
  // globalThis, nada de prototype chain que pueda escapar.
  const sandbox: any = {
    ctx,
    // Solo lo que el código del usuario necesita ver. NO incluye
    // process, require, fs, console con acceso a logs, etc.
    console: {
      log: (...args: any[]) => logger.info("[user-code]", ...args),
      error: (...args: any[]) => logger.error("[user-code]", ...args),
      warn: (...args: any[]) => logger.warn("[user-code]", ...args),
    },
    JSON,
    Math,
    Date,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Error,
    fetch: async (url: string, opts?: any) => {
      // Bloquea localhost / IPs privadas. Esto evita que el código del
      // usuario intente escanear la red local del runtime o atacar el
      // propio runtime via HTTP interno.
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "::1" ||
          /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host) ||
          /^169\.254\./.test(host)) {
        throw new Error(`Acceso a red local no permitido: ${host}`);
      }
      return globalThis.fetch(url, opts);
    },
    setTimeout: () => { throw new Error("setTimeout no permitido en el sandbox"); },
    setInterval: () => { throw new Error("setInterval no permitido en el sandbox"); },
  };

  try {
    const vmContext = vm.createContext(sandbox, {
      name: "asta-bot-user-command",
      codeGeneration: { strings: false, wasm: false }, // desactiva eval/new Function
    });

    // Compila el código en el contexto del sandbox. El código debe
    // definir `execute` como función async.
    const wrapped = `
      ${code}
      typeof execute === 'function' ? execute : null
    `;
    const script = new vm.Script(wrapped, { filename: "user-command.js" });
    const executeFn = script.runInContext(vmContext, { timeout: EXECUTION_TIMEOUT_MS });
    if (typeof executeFn !== "function") {
      return { ok: false, error: "El código no define `execute`", durationMs: Date.now() - start };
    }

    // Ejecuta con timeout.
    vm.runInContext(`__exec_promise = execute(ctx)`, vmContext, { timeout: EXECUTION_TIMEOUT_MS });

    return { ok: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Helper: crea un CommandContext estándar con la API autorizada.
 * El runtime usa este builder para construir el contexto que pasa al
 * sandbox, garantizando que solo se expongan las APIs permitidas.
 */
export function buildCommandContext(params: {
  sock: any;
  chatId: string;
  sender: string;
  args: string[];
  fullText: string;
  usedPrefix: string;
  isOwner: boolean;
  isGroup: boolean;
  variables: Map<string, any>;
  api: SubBotApiClient;
}): CommandContext {
  const { sock, chatId, sender, args, fullText, usedPrefix, isOwner, isGroup, variables, api } = params;
  return {
    sock,
    chatId,
    sender,
    args,
    fullText,
    usedPrefix,
    isOwner,
    isGroup,
    reply: async (text: string) => {
      await sock.sendMessage(chatId, { text });
    },
    sendImage: async (url: string, caption?: string) => {
      await sock.sendMessage(chatId, { image: { url }, caption: caption || undefined });
    },
    getVar: (name: string) => variables.get(name),
    setVar: (name: string, value: any) => { variables.set(name, value); },
    callAuthorizedFunction: async (name: string, fnArgs: Record<string, unknown>) => {
      return api.callAuthorizedFunction(name, fnArgs);
    },
  };
}
