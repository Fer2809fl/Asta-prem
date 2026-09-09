import fs from "node:fs";
import { config } from "../config.js";

// Este archivo contiene el token de runtime en texto plano en disco.
// Es equivalente a una API key de un solo dispositivo: si se filtra, se
// puede rotar/revocar desde el panel web (POST /token/rotate|revoke).
// No es un secreto compartido del servidor -cada Sub-Bot tiene el suyo- y
// nunca debe imprimirse en logs ni subirse a GitHub (data/ está en
// .gitignore).
export interface RuntimeState {
  botId: string | null;
  token: string | null;
  linked: boolean;
  phoneNumber: string | null;
  linkCode: string | null;
  linkCodeExpiresAt: string | null;
  runtimeVersion: string;
}

const DEFAULT_STATE: RuntimeState = {
  botId: null,
  token: null,
  linked: false,
  phoneNumber: null,
  linkCode: null,
  linkCodeExpiresAt: null,
  runtimeVersion: config.runtimeVersion,
};

export function loadState(): RuntimeState {
  if (!fs.existsSync(config.stateFile)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(fs.readFileSync(config.stateFile, "utf-8"));
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state: RuntimeState): void {
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(config.stateFile, 0o600);
  } catch {
    // chmod puede fallar en algunos sistemas de archivos de Termux (FAT/exFAT
    // en tarjetas SD externas); no es crítico, el archivo igual se guarda.
  }
}

export function clearState(): void {
  saveState({ ...DEFAULT_STATE });
}
