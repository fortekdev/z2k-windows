//go:build !windows

package main

const (
	defaultDevice = "/opt/etc/z2k-warp/device.json"
	defaultStatus = "/tmp/z2k-warp/status.json"
	defaultLog    = "/tmp/z2k-warp/warpd.log"
	// Запасные эндпоинты и пулы — см. комментарий в main.go.
	defaultEndpoints = "/opt/zapret2/lists/warp-endpoints.txt"
	defaultScanPools = "/opt/zapret2/lists/warp-scan-pools.txt"
	// Пусто — z2ktunN из device.json или первый свободный.
	defaultTunName = ""
	// На роутере демон запускает init-скрипт со stdin из /dev/null.
	defaultStdinWatch = false
	// DNS-наблюдатель (NFLOG) — только на роутере.
	observerEnabled = true
)

// edgeCachePath: пусто — значение по умолчанию движка
// (/opt/etc/z2k-warp/edge-cache.json), как было.
func edgeCachePath(string) string { return "" }
