#!/bin/sh
# Установка релея Telegram (z2k-vps-relay из necronicle/z2k) на свой VPS — для маршрута «Свой VPS-релей» в z2k Windows.
#
# Нужно: VPS за пределами РФ, Debian 12+ / Ubuntu 22.04+, x86_64, root, свободные порты 80 и 443 (или свой порт).
# Положите рядом этот файл и z2k-vps-relay и запустите:
#
#   sh install.sh                 # имя для сертификата: <IP>.nip.io
#   sh install.sh relay.example.com
#   sh install.sh relay.example.com 8443
#
# Тракт как у автора z2k: caddy (TLS Let's Encrypt, путь /ws) → релей на 127.0.0.1:8080 → дата-центры Telegram.
# Релей соединяется только с подсетями Telegram, открытым прокси он не становится.
# Повторный запуск обновляет бинарник и сохраняет секрет.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "Нужен x86_64, а здесь $(uname -m)"; exit 1; }
[ -f "$DIR/z2k-vps-relay" ] || { echo "Рядом с install.sh нет z2k-vps-relay"; exit 1; }
command -v apt-get >/dev/null || { echo "Нужен Debian или Ubuntu (apt-get)"; exit 1; }

HOST="${1:-}"
PORT="${2:-443}"
if [ -z "$HOST" ]; then
  command -v curl >/dev/null || apt-get install -y curl
  IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me)
  [ -n "$IP" ] || { echo "Не удалось узнать внешний IP — укажите домен: sh install.sh <домен>"; exit 1; }
  HOST="$IP.nip.io" # бесплатное имя, указывающее на этот IP, — нужно для сертификата
fi
echo "== Релей будет доступен как wss://$HOST$( [ "$PORT" = 443 ] || echo ":$PORT" )/ws"

# --- релей ---
systemctl stop z2k-relay 2>/dev/null || true
install -m 0755 "$DIR/z2k-vps-relay" /usr/local/bin/z2k-vps-relay
id z2k-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin z2k-relay
mkdir -p /etc/z2k-relay /var/lib/z2k-relay
[ -s /etc/z2k-relay/secret ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /etc/z2k-relay/secret
chown -R z2k-relay /etc/z2k-relay /var/lib/z2k-relay
chmod 600 /etc/z2k-relay/secret

# Протокол v1 с общим секретом: так с релеем говорит z2k Windows. Секрет читается из файла (@/путь), в argv его нет.
cat > /etc/systemd/system/z2k-relay.service <<EOF
[Unit]
Description=z2k Telegram relay
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/z2k-vps-relay --listen=127.0.0.1:8080 --secret=@/etc/z2k-relay/secret --registry-path=/var/lib/z2k-relay/registry.json
Environment=GOMEMLIMIT=400MiB
User=z2k-relay
Restart=always
RestartSec=2
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now z2k-relay

# --- caddy (TLS) ---
if ! command -v caddy >/dev/null; then
  apt-get update
  if ! apt-get install -y caddy; then
    # в старых выпусках caddy нет — официальный репозиторий (caddyserver.com/docs/install)
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
  fi
fi
SITE="$HOST"
[ "$PORT" = 443 ] || SITE="$HOST:$PORT"
cat > /etc/caddy/z2k-relay.caddy <<EOF
$SITE {
	handle /ws {
		reverse_proxy 127.0.0.1:8080
	}
	handle {
		respond 404
	}
}
EOF
# Свой конфиг — отдельным файлом: существующий Caddyfile не трогаем, только подключаем
touch /etc/caddy/Caddyfile
grep -q 'import /etc/caddy/z2k-relay.caddy' /etc/caddy/Caddyfile || printf '\nimport /etc/caddy/z2k-relay.caddy\n' >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow "$PORT"/tcp >/dev/null
fi

# --- проверка: /ws без WebSocket-заголовков релей отвергает с 400 — значит, тракт TLS → caddy → релей жив ---
URL="https://$SITE/ws"
echo "== Жду сертификат и проверяю $URL ..."
code=000
i=0
while [ $i -lt 30 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL" || true)
  [ "$code" = 400 ] && break
  i=$((i + 1))
  sleep 3
done
if [ "$code" != 400 ]; then
  echo "!! Проверка не прошла (HTTP $code). Смотрите: journalctl -u caddy -n 50; journalctl -u z2k-relay -n 50"
  exit 1
fi

echo
echo "Готово. В z2k Windows: Telegram → Маршрут до Telegram → «Свой VPS-релей»:"
echo "  Адрес:  wss://$SITE/ws"
echo "  Секрет: $(cat /etc/z2k-relay/secret)"
