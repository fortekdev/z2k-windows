//go:build !windows

// Package flock — эксклюзивная неблокирующая блокировка файла. На Unix это
// flock(2), на Windows — LockFileEx; обе снимаются ОС при любой смерти
// процесса, поэтому мёртвый замок невозможен.
package flock

import (
	"os"
	"syscall"
)

// TryLock берёт эксклюзивный замок без ожидания; ошибка — замок занят
// (или не поддерживается).
func TryLock(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

// Unlock снимает замок.
func Unlock(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
