//go:build windows

// Package flock — эксклюзивная неблокирующая блокировка файла. На Unix это
// flock(2), на Windows — LockFileEx; обе снимаются ОС при любой смерти
// процесса, поэтому мёртвый замок невозможен.
package flock

import (
	"os"

	"golang.org/x/sys/windows"
)

// TryLock берёт эксклюзивный замок без ожидания; ошибка — замок занят.
func TryLock(f *os.File) error {
	ol := new(windows.Overlapped)
	return windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ol)
}

// Unlock снимает замок.
func Unlock(f *os.File) error {
	ol := new(windows.Overlapped)
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, ol)
}
