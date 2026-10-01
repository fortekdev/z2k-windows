//go:build windows

package main

import (
	"os"
	"path/filepath"

	"github.com/necronicle/z2k/z2k-warpd/internal/tundev"
)

// Windows (z2k Windows): состояние — в %ProgramData%\z2k-windows\warp\,
// списки — в ..\lists\ относительно exe (resources\bin\z2k-warpd.exe →
// resources\lists\). Приложение может передать любые пути флагами явно.
var (
	dataDir          = filepath.Join(programData(), "z2k-windows", "warp")
	defaultDevice    = filepath.Join(dataDir, "device.json")
	defaultStatus    = filepath.Join(dataDir, "status.json")
	defaultLog       = filepath.Join(dataDir, "warpd.log")
	defaultEndpoints = listPath("warp-endpoints.txt")
	defaultScanPools = listPath("warp-scan-pools.txt")
)

const (
	defaultTunName = tundev.WindowsName
	// Приложение запускает движок с pipe на stdin: EOF = родитель ушёл.
	defaultStdinWatch = true
	// Доменная маршрутизация на Windows — забота приложения; NFLOG нет.
	observerEnabled = false
)

// edgeCachePath — кэш выбора узла рядом с device.json (как на роутере:
// /opt/etc/z2k-warp/), чтобы тестовый запуск с другим --device не писал в
// каталог приложения.
func edgeCachePath(devPath string) string {
	return filepath.Join(filepath.Dir(devPath), "edge-cache.json")
}

func programData() string {
	if p := os.Getenv("ProgramData"); p != "" {
		return p
	}
	return `C:\ProgramData`
}

// listPath — <exe>\..\lists\name, если есть, иначе <exe>\lists\name, иначе
// снова первый вариант (нет файла — работает встроенный список).
func listPath(name string) string {
	exe, err := os.Executable()
	if err != nil {
		return name
	}
	dir := filepath.Dir(exe)
	up := filepath.Join(dir, "..", "lists", name)
	if _, err := os.Stat(up); err == nil {
		return filepath.Clean(up)
	}
	if side := filepath.Join(dir, "lists", name); fileExists(side) {
		return side
	}
	return filepath.Clean(up)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
