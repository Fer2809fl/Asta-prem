import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import axios from "axios";
import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { SubBotApiClient } from "./api/client.js";

// Flujo (según lo pedido): comprobar compatibilidad → obtener manifiesto →
// descargar solo el componente autorizado → verificar hash → respaldar →
// aplicar → comprobar que funciona → rollback si falla.
//
// Deliberadamente NO ejecuta nada descargado: solo reemplaza archivos de
// datos/código dentro de este mismo proyecto, verificados por sha256
// contra el checksum que un admin registró en /admin/components. Si el
// componente no tiene checksum registrado, la actualización se rechaza
// en vez de aplicarse "a ciegas".

const TMP_DOWNLOAD = path.join(config.dataDir, "update-download.tmp");
const TMP_EXTRACT = path.join(config.dataDir, "update-extract.tmp");

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function cleanTmp(): void {
  for (const p of [TMP_DOWNLOAD, TMP_EXTRACT]) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
}

export async function checkForUpdate(api: SubBotApiClient): Promise<{ available: boolean; latestVersion?: string; notes?: string | null }> {
  const updates = await api.getUpdates();
  const mine = updates.find((u) => u.name === config.componentName);
  if (!mine) return { available: false };
  return {
    available: !!mine.updateAvailable,
    latestVersion: mine.latestVersion,
    notes: mine.notes,
  };
}

/**
 * Descarga y aplica la actualización del propio runtime.
 * Espera que el componente sea un .tar.gz que, al extraerse, contenga
 * (al menos) dist/ y package.json en su raíz.
 * Devuelve true si se aplicó correctamente, false si se rechazó o falló
 * (y en ese caso el runtime sigue exactamente como estaba: no se toca
 * nada hasta que la verificación de checksum pasa).
 */
export async function applyUpdate(api: SubBotApiClient): Promise<boolean> {
  cleanTmp();

  const info = await api.getComponentDownload(config.componentName);
  if (!info.checksum) {
    logger.error(
      `Actualización a ${info.version} rechazada: el componente no tiene checksum registrado en el servidor. No se aplica nada a ciegas.`
    );
    return false;
  }

  logger.info(`Descargando actualización ${info.version} desde ${info.url}...`);
  const response = await axios.get<ArrayBuffer>(info.url, { responseType: "arraybuffer", timeout: 120_000 });
  fs.writeFileSync(TMP_DOWNLOAD, Buffer.from(response.data));

  const actualChecksum = sha256File(TMP_DOWNLOAD);
  if (actualChecksum.toLowerCase() !== info.checksum.toLowerCase()) {
    logger.error(
      `Checksum no coincide para ${config.componentName} ${info.version} (esperado ${info.checksum}, obtenido ${actualChecksum}). Actualización abortada.`
    );
    cleanTmp();
    return false;
  }
  logger.ok("Checksum verificado.");

  fs.mkdirSync(TMP_EXTRACT, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", TMP_DOWNLOAD, "-C", TMP_EXTRACT], { stdio: "pipe" });
  } catch (err) {
    logger.error("No se pudo extraer el paquete de actualización (¿'tar' está instalado? en Termux: pkg install tar):", err);
    cleanTmp();
    return false;
  }

  // Respaldo antes de tocar nada, para poder hacer rollback si algo falla.
  const backupPath = path.join(config.backupDir, `pre-update-${config.runtimeVersion}-${Date.now()}`);
  fs.mkdirSync(backupPath, { recursive: true });
  for (const entry of ["dist", "package.json"]) {
    const src = path.join(config.rootDir, entry);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(backupPath, entry), { recursive: true });
    }
  }

  try {
    for (const entry of ["dist", "package.json"]) {
      const extracted = path.join(TMP_EXTRACT, entry);
      if (!fs.existsSync(extracted)) continue;
      const dest = path.join(config.rootDir, entry);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(extracted, dest, { recursive: true });
    }

    // Comprobación mínima de que la actualización quedó en un estado
    // arrancable antes de darla por buena.
    const entryPoint = path.join(config.rootDir, "dist", "index.js");
    if (!fs.existsSync(entryPoint) || fs.statSync(entryPoint).size === 0) {
      throw new Error("dist/index.js no existe o está vacío tras aplicar la actualización.");
    }

    await api.postStatus({ runtime_version: info.version });
    // Reportar al servidor que la actualización se aplicó OK — el panel
    // lo mostrará en el historial de actualizaciones del Sub-Bot.
    await api.reportUpdateApplied({
      fromVersion: config.runtimeVersion,
      toVersion: info.version,
      success: true,
    });
    logger.ok(`Actualizado a ${info.version}. Reinicia el runtime para aplicar el cambio (Ctrl+C y volver a ejecutar 'npm start').`);
    cleanTmp();
    return true;
  } catch (err) {
    logger.error("La actualización falló al aplicarse. Restaurando la versión anterior (rollback)...", err);
    for (const entry of ["dist", "package.json"]) {
      const backupEntry = path.join(backupPath, entry);
      const dest = path.join(config.rootDir, entry);
      if (fs.existsSync(backupEntry)) {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(backupEntry, dest, { recursive: true });
      }
    }
    // Reportar al servidor el fallo + rollback para que el panel lo muestre.
    try {
      await api.reportUpdateApplied({
        fromVersion: config.runtimeVersion,
        toVersion: info.version,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch { /* best-effort */ }
    logger.warn("Rollback completo. El runtime sigue en la versión anterior.");
    cleanTmp();
    return false;
  }
}
