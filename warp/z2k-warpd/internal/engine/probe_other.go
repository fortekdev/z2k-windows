//go:build !windows

package engine

// На Linux пробы ходят обычным сокетом с SO_BINDTODEVICE — стек не нужен.
func (e *Engine) attachProbeStack(string) error { return nil }

func (e *Engine) detachProbeStack() {}
