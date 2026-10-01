// Package tundev — туннельный интерфейс z2ktunN.
//
// Имя своё, не opkgtunN: NDM принимает только тип OpkgTun, а opkgtunN делят
// все Entware-туннели (usque, AWG, TrustTunnel) — конфликт имён со старыми
// установками был реальной жалобой. Интерфейс в NDM не регистрируется вовсе;
// NAT и MSS делаем сами (internal/nat).
//
// Платформенная часть (Create/Configure/Teardown/Info) — в tundev_other.go
// (Linux: команды ip) и tundev_windows.go (Wintun + winipcfg).
package tundev

import (
	"fmt"
	"os/exec"
	"strings"
)

// Runner выполняет внешнюю команду; подменяется в тестах.
type Runner func(name string, args ...string) (string, error)

// Exec — Runner по умолчанию: exec.Command + CombinedOutput.
func Exec(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// AddrConflictError — адрес туннеля уже стоит на ДРУГОМ интерфейсе (Windows:
// второй туннель WARP — официальный клиент, чужой экземпляр, сирота). Каждое
// устройство WARP получает 172.16.0.2, поэтому конфликт — штатная ситуация,
// и сообщение о ней должно читаться человеком.
type AddrConflictError struct {
	Addr  string
	Alias string
}

func (e *AddrConflictError) Error() string {
	return fmt.Sprintf("addr_conflict: адрес %s уже занят интерфейсом %q (другой клиент WARP?)", e.Addr, e.Alias)
}

// Prefix — префикс имени интерфейса.
const Prefix = "z2ktun"

// PickName — первый z2ktunN, которого нет. exists — проверка существования netdev.
func PickName(exists func(string) bool) string {
	for n := 0; n < 16; n++ {
		name := fmt.Sprintf("%s%d", Prefix, n)
		if !exists(name) {
			return name
		}
	}
	return Prefix + "0"
}

func firstLine(out string, err error) string {
	if out == "" {
		return err.Error()
	}
	if i := strings.IndexByte(out, '\n'); i > 0 {
		return out[:i]
	}
	return out
}
