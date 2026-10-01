# z2k Windows

Порт [necronicle/z2k](https://github.com/necronicle/z2k) (zapret2 для Keenetic) под Windows: приложение на Electron 44 + Next.js 16 / React 19.

- **Обход DPI** — движок zapret2 `winws2.exe` (WinDivert) с профилями и стратегиями z2k: RKN (50 стратегий), YouTube (22), googlevideo (22), QUIC (9), голос Discord (6), HTTP (8).
- **Автоподбор** — штатный механизм z2k `circular` + Lua-детекторы z2k (TLS alert, тишина QUIC, ретрансмиссии). Выбор по каждому домену хранится в `state.tsv`; его можно посмотреть, сменить или заморозить. Кнопка «Подобрать» прогоняет каждую стратегию пула через настоящий winws2 и проверяет её HTTPS-запросом к сайту.
- **Telegram-прокси** — локальный SOCKS5 с пятью маршрутами:
  - **Через WARP** (по умолчанию) — подсети Telegram заворачиваются маршрутами в туннель движка `z2k-warpd` (тот же, что у игрового режима). Нужен, когда Telegram заблокирован по IP целиком, включая фронт WebSocket. Работает для всех программ без настроек прокси, в том числе для веб-версии и звонков (UDP). Аккаунт Cloudflare не нужен: устройство WARP регистрируется автоматически.
  - **WebSocket Telegram**. DC определяется по obfuscated2-заголовку MTProto, трафик идёт через `wss://kwsN.web.telegram.org/apiws` (media — `kwsN-1`).
  - **Свой VPS-релей** — серверная часть `vps-relay/` (из z2k, MIT) на вашем сервере и с вашим секретом. Нужен, когда Telegram заблокирован по IP целиком, включая фронт WebSocket. Клиент говорит с релеем по протоколу v1 (общий секрет). Установка на VPS — одним скриптом, см. ниже.
  - **Свой Cloudflare Worker** — это cf-worker из истории z2k (апрель 2026): мультиплексированный TCP поверх WebSocket с авторизацией HMAC. Worker публикуется в аккаунт пользователя в один клик по API-токену, бесплатного тарифа хватает. В отличие от оригинала, Worker пускает только к подсетям Telegram.
  - **Напрямую**.
- **Прозрачный режим Telegram** (включён по умолчанию) — порт `z2k-tg-redirect.sh`. На роутере z2k заворачивает подсети Telegram через `iptables REDIRECT` на свой туннель; здесь то же самое делает `z2k-tgredir.exe` через WinDivert. Он отражает исходящие TCP 443/80/5222 к подсетям Telegram на свой порт (схема streamdump) и передаёт их в SOCKS5-прокси с исходным адресом. В итоге Telegram Desktop без настроек прокси и веб-версия в браузере идут тем же маршрутом. Свои соединения z2k определяются по PID через `GetExtendedTcpTable` и не перехватываются, поэтому петли нет. Хелпер работает с приоритетом WinDivert выше, чем у winws2, и завершается вместе с приложением. Веб-версии нужен маршрут «Свой Cloudflare Worker»: в режиме WebSocket TLS браузера уходит напрямую. Звонки (UDP) не перехватываются.
- **Instagram, WhatsApp, Facebook при блокировке по IP** — порт идеи `z2k-insta-ip-refresh` без правки системных файлов. Приложение находит заблокированные адреса Meta и рабочие замены: адреса из других стран через DoH с EDNS Client Subnet, фильтр по диапазонам Meta, проверка соединением. Движок подменяет адрес прямо во входящем DNS-ответе (Lua `resources/lua-win/z2k-win-dnsfix.lua`). Не действует при «безопасном DNS» (DoH) в браузере; AAAA-записи не подменяются.
- **DNS через DoH на время работы обхода** (по умолчанию `https://xbox-dns.ru/dns-query`). Локальный DNS-прокси на 127.0.0.1/::1 (UDP и TCP), DNS активных адаптеров переключается на него и возвращается как было (DHCP или свои адреса) при остановке, выходе и после сбоя. Если российский резолвер отдаёт заглушку РКН (127.0.0.1 / 0.0.0.0), прокси переспрашивает зарубежный DoH. Подмена заблокированных по IP адресов работает и здесь. Если DoH недоступен, используется прежний DNS.
- **Игровой режим WARP (Cloudflare)** — порт движка `z2k-warpd` под Windows (Wintun): регистрация устройства в Cloudflare, WireGuard по UDP с запасными портами и MASQUE по TCP 443, выбор узла. Split-туннель строится по спискам игр [YOZH3G/ru-gaming-blocklist](https://github.com/YOZH3G/ru-gaming-blocklist), своим адресам и доменам (`*.domain` — по DNS-кэшу Windows). Есть и режим «весь трафик». Пока туннель не готов, маршрутов нет, и трафик идёт напрямую.
- Списки (runetfreedom/russia-blocked-geosite, обработка как в `z2k-geosite.sh`), исключения по домену и по IP, диагностика домена (DNS → TCP → TLS → HTTP, обрыв на 16 КБ), системные проверки (метки времени TCP, конфликтующие обходчики, блокировка Instagram/WhatsApp по IP). Системный файл hosts приложение не меняет, трей, автозапуск через планировщик.

## Свой релей Telegram на VPS

Когда провайдер блокирует Telegram по IP целиком (не отвечают ни дата-центры, ни фронт web.telegram.org), трафик нужно вывести через сервер за границей — свой VPS с релеем.

1. VPS за пределами РФ: Debian 12+ или Ubuntu 22.04+, x86_64, root по SSH, свободные порты 80 и 443.
2. В приложении: Telegram → маршрут «Свой VPS-релей» → «Открыть папку». В PowerShell:
   ```powershell
   scp "<папка>\z2k-vps-relay" "<папка>\install.sh" root@<IP>:/root/
   ssh root@<IP> "sh /root/install.sh"
   ```
   Скрипт ставит релей (systemd, отдельный пользователь, секрет в `/etc/z2k-relay/secret`) и caddy с сертификатом Let's Encrypt на имя `<IP>.nip.io` (можно передать свой домен: `sh install.sh relay.example.com`). Существующий Caddyfile не перезаписывается. В конце скрипт проверяет тракт и печатает адрес `wss://…/ws` и секрет.
3. Адрес и секрет — в параметры маршрута, «Применить», «Проверить DC».

Релей соединяется только с подсетями Telegram и пускает только по секрету. С прозрачным режимом через него идут и Telegram Desktop без настроек прокси, и веб-версия в браузере.

## Как устроено

```
electron/src/
  main.ts, window.ts, tray.ts, ipc.ts     окно (без меню и DevTools), трей, IPC с белым списком команд
  engine/profiles.ts                       разбор профилей z2k, пулы, «одна стратегия», свои строки
  engine/config.ts                         аргументы winws2: WinDivert-фильтр, lua-init, blob, списки
  engine/winws.ts                          процесс winws2: старт/стоп/dry-run/автоперезапуск
  engine/state.ts                          state.tsv с тем же замком, что у Lua и вебпанели z2k
  engine/lists.ts                          списки и их обновление
  autopick/probe.ts, autopick.ts           проба домена и подбор стратегии через движок
  tg/obfs.ts, tg/proxy.ts, tg/selftest.ts  obfuscated2, SOCKS5 → WebSocket Telegram, самопроверка DC
  tg/cfworker.ts, tg/cfdeploy.ts           клиент релея (Cloudflare Worker и VPS-релей z2k, протокол v1), публикация Worker
  tg/redirect.ts                           прозрачный режим: процесс z2k-tgredir
  warp/manager.ts, warp/lists.ts           WARP: движок z2k-warpd, маршруты netsh, списки игр
  system.ts                                админ, TCP timestamps, планировщик, конфликты
renderer/                                  Next.js (static export) — интерфейс
warp/z2k-warpd/                            Go-исходники движка WARP (порт z2k-warpd под Windows)
tgredir/                                   Go-исходники z2k-tgredir (перехват Telegram через WinDivert)
vps-relay/                                 Go-исходники релея Telegram из z2k (MIT, без изменений, см. UPSTREAM.md)
resources/vps-relay/                       сборка релея под linux/amd64 + install.sh для своего VPS
resources/cf-worker/worker.js              код Telegram-релея для Cloudflare Workers
resources/                                 движок и данные (собираются scripts/fetch-engine.mjs)
```

Профили не переписаны с bash вручную. `scripts/gen-profiles.sh` прогоняет **настоящий** генератор z2k (`lib/config_official.sh`) в песочнице, и результат сохраняется в `resources/strategies/z2k-profiles.txt`. TypeScript подставляет в него пути, переключатели и свои строки, а также собирает фильтр WinDivert.

Отличия от роутерной версии:
- `nfqws2` заменён на `winws2` из upstream bol-van/zapret2: у форка z2k нет Windows-сборки. Lua-ядро форка работает на нём без изменений.
- TLS-моды `z2k_*` из C-патча форка вырезаются, потому что upstream их не знает. По умолчанию они и так выключены.
- Вместо connbytes используются `--wf-tcp-in`/`--wf-udp-in`, иначе детекторы автоподбора не видят ответы сервера.
- Lua пишет `state.tsv` только в каталог `--writable`, потому что winws2 понижает права процесса.

## Разработка

Требуются Node 22+ и Git for Windows (bash нужен для генератора профилей). Работать надо от администратора: WinDivert без админа не стартует.

```bash
npm install
npm run fetch:engine     # winws2 + WinDivert, Lua, списки, профили z2k → resources/
npm run build:warpd      # z2k-warpd.exe + wintun.dll → resources/bin (Go скачивается в .tools/)
npm run build:tgredir    # z2k-tgredir.exe → resources/bin (тот же Go из .tools/)
npm run build:relay      # z2k-vps-relay (linux/amd64) → resources/vps-relay
```

**F5 в VS Code** поднимает (или переиспользует) `next dev` на :3123 и `esbuild --watch`, после чего запускает Electron. Обе сборки видны во вкладках терминала. Без VS Code: `npm run dev`.

```bash
npm test                 # юнит-тесты ядра + Lua-тесты на LuaJIT самого winws2
npm run typecheck
npm run dist             # установщик NSIS + portable в release/ (requireAdministrator)
```

Данные приложения хранятся в `%ProgramData%\z2k-windows`: настройки, `state/state.tsv`, свои списки, свои стратегии, журналы.

Отладка UI без кликов: `Z2K_SCREENSHOT=out.png Z2K_VIEW=telegram electron .` откроет раздел, сохранит снимок и выйдет.

## Поддержать проект

Кнопки NOWPayments (криптовалюта) и Яндекс Чаевые — на «Обзоре» и в боковом меню приложения.

## Лицензии

z2k и zapret2 распространяются под MIT, WinDivert — под LGPLv3, cygwin1.dll — под LGPLv3, wireguard-go — под MIT, Wintun — по лицензии WireGuard LLC (prebuilt-бинарь, разрешено распространение).
