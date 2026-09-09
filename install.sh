#!/data/data/com.termux/files/usr/bin/bash
# Instalador del runtime de Termux para Asta-Bot.
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/Fer2809fl/Asta-prem/main/install.sh | bash
# o, dentro de una copia ya clonada del repo:
#   bash install.sh

set -euo pipefail

REPO_URL="https://github.com/Fer2809fl/Asta-prem.git"
INSTALL_DIR="$HOME/asta-bot-runtime"

echo "── Instalador de Asta-Bot (runtime de Termux) ──"
echo ""
echo "Este runtime NO te pide URLs ni API keys ni secretos."
echo "La configuración mínima es solo el nombre de tu bot."
echo ""

echo "[1/6] Comprobando permisos de almacenamiento..."
if [ ! -d "$HOME/storage" ]; then
  echo "  → Ejecuta 'termux-setup-storage' si necesitas guardar archivos fuera de Termux (opcional)."
fi

echo "[2/6] Instalando dependencias del sistema (node, git, tar)..."
pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs-lts git tar >/dev/null

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  ❌ Se requiere Node.js 20 o superior. Tienes $(node -v). Prueba: pkg install nodejs-lts"
  exit 1
fi
echo "  ✅ Node $(node -v), $(git --version)"

echo "[3/6] Descargando el runtime..."
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  → Ya existe una copia en $INSTALL_DIR, actualizando..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

echo "[4/6] Instalando dependencias de Node (puede tardar unos minutos)..."
npm install --no-fund --no-audit

echo "[5/6] Configurando..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  → Se creó .env a partir de .env.example."
  echo ""
  echo "  Por defecto, tu bot se llamará 'MiAstaBot'. Puedes cambiarlo ahora"
  echo "  o editando .env más tarde."
  read -rp "  Nombre del Sub-Bot [MiAstaBot]: " bot_name
  bot_name=${bot_name:-MiAstaBot}
  echo "  Método de vinculación de WhatsApp: 1) Código de 8 dígitos (recomendado)  2) Código QR"
  read -rp "  Elige 1 o 2 [1]: " method_choice
  method_choice=${method_choice:-1}
  if [ "$method_choice" = "2" ]; then
    login_method="qr"
    phone_line=""
  else
    login_method="pairing"
    read -rp "  Tu número con código de país, sin '+' ni espacios (ej: 521234567890): " phone
    phone_line="PHONE_NUMBER=$phone"
  fi
  # Reemplazar el contenido del .env con la configuración mínima
  cat > .env <<EOF
# Configuración mínima de tu Sub-Bot
BOT_NAME=$bot_name
LOGIN_METHOD=$login_method
EOF
  [ -n "$phone_line" ] && echo "$phone_line" >> .env
  echo "  ✅ .env configurado (solo BOT_NAME y LOGIN_METHOD)."
  echo "     La URL de la API se descubre automáticamente."
else
  echo "  → .env ya existe, no se modifica."
fi

echo "[6/6] Compilando..."
npm run build

echo ""
echo "✅ Instalación completa."
echo ""
echo "Para iniciar el runtime ahora:"
echo "  cd $INSTALL_DIR && npm start"
echo ""
echo "La primera vez te va a mostrar un CÓDIGO DE VINCULACIÓN (8 caracteres)"
echo "que debes pegar en el panel web de Asta-Bot → Mis Sub-Bots → Vincular runtime."
echo "Después, te mostrará un código de 8 dígitos para ingresar en tu celular en"
echo "WhatsApp → Dispositivos vinculados → Vincular con número de teléfono."
echo ""
echo "Nada más necesita configurarse. Sin URLs, sin API keys, sin secretos."
