# vps-relay — релей Telegram из z2k

Копия `vps-relay/` из [necronicle/z2k](https://github.com/necronicle/z2k), ветка `z2k-enhanced`, релиз p-86.7 (MIT, см. LICENSE), без изменений.
Скопированы только исходники Go: снимки конфигов боевого VPS автора (`deploy/vps-configs`) сюда не перенесены.

Сборка под VPS (linux/amd64): `npm run build:relay` → `resources/vps-relay/z2k-vps-relay`.
Установка на свой VPS: `resources/vps-relay/install.sh` (см. README проекта, раздел «Свой релей на VPS»).

Клиент z2k Windows говорит с релеем по протоколу v1 (общий секрет, кадр AUTH 0x00 = HMAC-SHA256(secret, secret)),
поэтому релей запускается без `--require-per-install` и без `--v1-off`.
