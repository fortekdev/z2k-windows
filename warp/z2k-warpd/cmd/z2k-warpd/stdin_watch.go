package main

import (
	"io"
	"os"
)

// watchStdin вызывает stop, когда stdin дочитан до конца (родитель закрыл
// pipe или умер). Следим только за pipe: stdin из NUL/файла дал бы EOF
// сразу, а консоль — это ручной запуск, там есть Ctrl+C. Возвращает,
// включено ли слежение.
func watchStdin(stop func()) bool {
	fi, err := os.Stdin.Stat()
	if err != nil || fi.Mode()&os.ModeNamedPipe == 0 {
		return false
	}
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop()
	}()
	return true
}
