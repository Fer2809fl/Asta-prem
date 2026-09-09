# Changelog

Este proyecto sigue [versionado semántico](https://semver.org/lang/es/): `MAJOR.MINOR.PATCH`.

## [1.0.0] - Fase 2

Primera versión pública del runtime de Termux.

### Agregado
- Registro automático del runtime contra la API central (`POST /api/subbot/v1/register`).
- Flujo de vinculación por código (`linkCode`) contra el panel web.
- Conexión de WhatsApp reutilizando el patrón de `core/subbot.ts` del proyecto principal (código de vinculación o QR, reconexión automática con backoff, detección de sesión corrupta/logout).
- Heartbeat periódico (`POST /api/subbot/v1/status`) con versión y estado de vinculación.
- Comprobación periódica de actualizaciones (`GET /api/subbot/v1/updates`) con descarga verificada por checksum, respaldo automático y rollback si la actualización falla.
- Instalador para Termux (`install.sh`) que comprueba Node.js, instala dependencias y configura `.env` de forma interactiva.
- Aislamiento total entre Sub-Bots: el runtime solo puede ver/tocar su propio `botId` (impuesto del lado del servidor por el token, no por este cliente).
