//go:build windows

package nat

// Ensure на Windows ничего не делает: трафик локальный (хост сам ходит в
// адаптер), форварда и маскарада нет, а MSS следует из MTU интерфейса.
func Ensure(Runner, string, int) error { return nil }

// Remove — пара к Ensure, тоже ничего.
func Remove(Runner, string, int) error { return nil }
