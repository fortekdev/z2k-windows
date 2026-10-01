package engine

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/necronicle/z2k/z2k-warpd/internal/flock"
)

// ErrAlreadyRunning — движок уже запущен другим процессом.
var ErrAlreadyRunning = errors.New("another z2k-warpd is already running")

// acquireLock берёт эксклюзивный flock. Без него два экземпляра сосуществуют
// ровно до TUN: второй падает с «device or resource busy» — и по дороге
// (defer status.Remove) СНОСИТ status.json живого первого, а init кладёт в
// pidfile его мёртвый pid. Дальше selfheal каждые 25 с поднимает новый
// обречённый процесс, панель показывает «движок не запущен», маршрут
// снимается — при живом туннеле. Поле r-79.4, три диагностики.
//
// flock (на Windows — LockFileEx, см. internal/flock), а не pidfile:
// снимается ядром при любой смерти процесса, включая
// SIGKILL и OOM, так что мёртвый замок невозможен.
func acquireLock(path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, err
	}
	if err := flock.TryLock(f); err != nil {
		f.Close()
		return nil, ErrAlreadyRunning
	}
	return func() {
		flock.Unlock(f)
		f.Close()
	}, nil
}
