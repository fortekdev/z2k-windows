#!/bin/bash
# Прогоняет НАСТОЯЩИЙ генератор конфигурации z2k (lib/config_official.sh) в песочнице
# и сохраняет результат для Windows-порта:
#   <out>/z2k-profiles.txt   — NFQWS2_OPT (профили), пути заменены на @Z2K@/...
#   <out>/lists/...          — списки в том виде, в каком их раскладывает установщик z2k
# Использование: bash scripts/gen-profiles.sh <z2k-checkout> <out-dir>
set -u
REPO="$1"; OUT="$2"
SB="$(mktemp -d)"
mkdir -p "$SB/opt/zapret2/lua" "$SB/etc" "$SB/work" "$OUT"
export ZAPRET2_DIR="$SB/opt/zapret2" CONFIG_DIR="$SB/etc" WORK_DIR="$SB/work" LIB_DIR="$REPO/lib"
export LISTS_DIR="$ZAPRET2_DIR/lists"
. "$REPO/lib/utils.sh" >/dev/null 2>&1
print_info(){ :; }; print_success(){ :; }; print_warning(){ echo "W: $*" >&2; }; print_error(){ echo "E: $*" >&2; }; print_header(){ :; }
. "$REPO/lib/strategies.sh"
. "$REPO/lib/config.sh"
. "$REPO/lib/config_official.sh"
STRATEGIES_CONF="$CONFIG_DIR/strategies.conf"; QUIC_STRATEGIES_CONF="$CONFIG_DIR/quic_strategies.conf"; QUIC_STRATEGY_FILE="$CONFIG_DIR/quic_strategy.conf"
RUTRACKER_QUIC_STRATEGY_FILE="$CONFIG_DIR/rq.conf"; CURRENT_STRATEGY_FILE="$CONFIG_DIR/cur"
generate_strategies_conf "$REPO/strats_new2.txt" "$STRATEGIES_CONF"
generate_quic_strategies_conf "$REPO/quic_strats.ini" "$QUIC_STRATEGIES_CONF"
mkdir -p "$ZAPRET2_DIR/files"; cp -r "$REPO/files/lists" "$ZAPRET2_DIR/files/lists"; cp -r "$REPO/files/lists" "$ZAPRET2_DIR/lists"
download_domain_lists >/dev/null 2>&1
create_base_config >/dev/null 2>&1
# генератор подключает детекторы только если lua-файлы на месте
for f in z2k-modern-core.lua z2k-alert.lua z2k-quic-silence.lua z2k-tcp16.lua; do cp "$REPO/files/lua/$f" "$ZAPRET2_DIR/lua/"; done
create_default_strategy_files
generate_nfqws2_opt_from_strategies > "$SB/opt.txt" || { echo "generator failed" >&2; exit 1; }
ROOT_WIN="$(cd "$ZAPRET2_DIR" && pwd -W 2>/dev/null || pwd)"
sed -e "s#${ROOT_WIN}#@Z2K@#g" -e "s#${ZAPRET2_DIR}#@Z2K@#g" "$SB/opt.txt" > "$OUT/z2k-profiles.txt"
mkdir -p "$OUT/lists"
cp "$ZAPRET2_DIR/lists/whitelist.txt" "$OUT/lists/whitelist.txt"
cp -r "$ZAPRET2_DIR/extra_strats" "$OUT/lists/"
rm -rf "$SB"
echo "profiles: $(grep -o -- '--lua-desync=' "$OUT/z2k-profiles.txt" | wc -l) lua-desync instances"
