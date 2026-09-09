# Asta-Bot · Runtime de Termux (Sub-Bot)

Programa que corre en tu celular (dentro de [Termux](https://termux.dev/)) y conecta **tu propio Sub-Bot** de WhatsApp con la plataforma Asta-Bot. Cada persona corre su propia copia; tu sesión de WhatsApp y tus datos nunca salen de tu dispositivo salvo hacia la API oficial.

## Filosofía (Fase 3)

El runtime está diseñado para ser **ligero y cerrado**:

- **Configuración mínima**: solo `BOT_NAME=MiAstaBot` en `.env`. El resto (URL de la API, tokens, secretos) se gestiona automáticamente.
- **Sin secretos visibles**: el usuario no necesita ni debe ver API keys, URLs privadas, contraseñas o tokens. El runtime descubre la infraestructura oficial y se autentica con un token emitido automáticamente al registrarse.
- **Sin código privado**: el runtime solo ejecuta comandos oficiales firmados y comandos personalizados del usuario en un sandbox aislado (sin `fs`, `process`, `child_process`, `require`, red local).
- **La API es la autoridad**: cualquier función sensible (base de datos, otras APIs, integraciones) se ejecuta en el servidor vía `callAuthorizedFunction` — el runtime nunca recibe credenciales del servidor.

## Instalación rápida

Dentro de Termux:

```bash
curl -fsSL https://raw.githubusercontent.com/Fer2809fl/asta-bot-termux-runtime/main/install.sh | bash
cd ~/asta-bot-runtime
cp .env.example .env
# Edita .env y ponle: BOT_NAME=MiAstaBot
npm start
```

El instalador comprueba Node.js y `tar`, instala dependencias, y crea el `.env` con la configuración mínima.

## Primer uso

1. Al ejecutar `npm start` por primera vez, el runtime descubre la API oficial automáticamente y se registra solo.
2. Muestra un **código de vinculación** en la terminal (8 caracteres, válido 10 minutos).
3. Entra al panel web de Asta-Bot → Mis Sub-Bots → "Vincular runtime", y pega ese código.
4. El runtime detecta la vinculación solo y pasa a conectar WhatsApp: te muestra un código de 8 dígitos para ingresar en tu celular en **WhatsApp → Dispositivos vinculados → Vincular con número de teléfono**.
5. Listo — el Sub-Bot queda activo y sincroniza comandos/flows desde el panel automáticamente.

Reinicios posteriores reutilizan la sesión guardada en `data/`; no hace falta repetir estos pasos salvo que cierres sesión desde el propio WhatsApp.

## Variables de entorno (`.env`)

| Variable | Requerido | Descripción | Por defecto |
|---|---|---|---|
| `BOT_NAME` | **Sí** | Nombre visible del Sub-Bot en WhatsApp y en el panel | generado |
| `LOGIN_METHOD` | No | `pairing` (recomendado) o `qr` | `pairing` |
| `PHONE_NUMBER` | Solo si `pairing` | Tu número con código de país, sin `+` | — |
| `API_BASE_URL` | No | Override avanzado de la URL oficial | discovery automático |
| `HEARTBEAT_INTERVAL_MS` | No | Frecuencia de reporte de estado | `60000` |
| `UPDATE_CHECK_INTERVAL_MS` | No | Frecuencia de revisión de actualizaciones | `21600000` (6h) |
| `SYNC_INTERVAL_MS` | No | Frecuencia de sincronización de comandos/flows | `300000` (5min) |

**No hay secretos en este `.env`.** Todo lo sensible vive en el servidor.

## Qué hace

- **Discovery automático**: detecta la URL de la API oficial sin que el usuario la configure.
- **Registro y vinculación**: se registra solo, emite token automáticamente, muestra código de vinculación al usuario.
- **Conexión WhatsApp**: pairing code o QR, con reconexión automática.
- **Heartbeat**: reporta estado cada minuto a la API central.
- **Sincronización**: descarga comandos custom y flows del usuario desde el panel, cada 5 minutos o al recibir push via WebSocket.
- **Sandbox**: ejecuta comandos personalizados en VM aislada sin acceso a filesystem/process/red local.
- **Actualizaciones**: revisa cada 6h si hay nueva versión del runtime; descarga con checksum y rollback automático si falla.

## Qué NO hace (por diseño)

- No recibe ni guarda datos, sesiones ni secretos de otros usuarios.
- No recibe API keys ni contraseñas del servidor — la lógica sensible vive en la API.
- No ejecuta código arbitrario: las actualizaciones solo reemplazan archivos de este mismo proyecto, y solo si el checksum coincide con el que un administrador registró.
- Los comandos de usuario se ejecutan en sandbox sin acceso a `fs`, `process`, `child_process`, `require`, red local.

## Mantener corriendo el runtime

Termux mata procesos en segundo plano por defecto. Opciones:

- **Termux:Boot / wake-lock**: `termux-wake-lock` antes de `npm start`.
- **tmux o screen**: `pkg install tmux`, corre `npm start` dentro de una sesión de `tmux` para que sobreviva a que cierres la app de Termux.
- Para reiniciar automáticamente: `while true; do npm start; sleep 5; done`.

## Solución de errores frecuentes

| Problema | Causa probable | Solución |
|---|---|---|
| `Token de runtime inválido, revocado o expirado` | Rotaste o revocaste el token desde el panel | Borra la carpeta `data/` y vuelve a ejecutar `npm start` para registrar un Sub-Bot nuevo |
| El código de vinculación venció | Pasaron más de 10 minutos sin pegarlo en el panel | El runtime genera uno nuevo solo la próxima vez que lo ejecutes |
| `LOGIN_METHOD=pairing requiere PHONE_NUMBER` | Falta el número en `.env` | Completa `PHONE_NUMBER` sin `+` ni espacios |
| Sesión corrupta (406) / logout | WhatsApp cerró la sesión desde el celular | El runtime borra la sesión local sola y hay que vincular de nuevo |
| `tar: not found` al actualizar | Falta el paquete `tar` | `pkg install tar` |
| Se detiene solo tras un rato | Termux mató el proceso en segundo plano | Ver sección "Mantener corriendo el runtime" |

## Seguridad

- **Aislamiento por token**: cada runtime solo puede leer/modificar su propio Sub-Bot — lo impone el servidor a partir del `x-subbot-token`, no una promesa de este cliente.
- **Token persistente**: vive en `data/runtime-state.json` (gitignored, permisos 600), nunca se imprime en logs, nunca se reenvía al servidor en claro.
- **Updates firmados**: las actualizaciones se rechazan si el componente no tiene checksum registrado; si el checksum descargado no coincide, no se toca ningún archivo. Rollback automático si la actualización falla al aplicar.
- **Sandbox de comandos**: los comandos personalizados del usuario se ejecutan en `vm.Context` sin `require`, sin `process`, sin `fs`, sin `child_process`, sin red local. Timeout de 5 segundos por ejecución.
- **Sin secretos en `.env`**: ni el usuario ni nadie que vea el `.env` obtiene acceso al servidor — el token se genera automáticamente al registrarse y se guarda localmente.

## Estructura

```
src/
  api/client.ts         # Cliente contra /api/subbot/v1
  whatsapp/session.ts   # Conexión de WhatsApp (Baileys)
  util/state.ts         # Persistencia local de botId/token/versión
  util/logger.ts
  update.ts             # Comprobación y aplicación de actualizaciones
  sync.ts               # Sincronización de comandos/flows desde el panel
  sandbox.ts            # VM aislada para ejecutar comandos de usuario
  config.ts             # Carga .env mínimo, resolve API URL automática
  index.ts              # Orquestación: discover → register → link → WhatsApp → heartbeat → updates → sync
install.sh              # Instalador interactivo para Termux
.env.example            # Configuración MÍNIMA (solo BOT_NAME)
```
