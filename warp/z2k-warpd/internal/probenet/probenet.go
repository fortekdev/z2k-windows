// Package probenet — как пробы (health, edgepick) ходят «через туннель».
//
// На Linux проба — обычный сокет с SO_BINDTODEVICE на z2ktunN. На Windows
// аналог (IP_UNICAST_IF) требует маршрута через адаптер к адресу пробы, а
// маршрутов движок не ставит — ими управляет приложение. Поэтому на Windows
// движок поднимает userspace-стек (gVisor netstack из wireguard-go) с адресом
// туннеля, подключённый к транспорту в обход ОС (tunshare.AttachSide), и
// регистрирует здесь его Dial. Не задан — пробы идут по-старому.
package probenet

import (
	"context"
	"net"
	"sync/atomic"
)

// DialFunc — как net.Dialer.DialContext.
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

var dial atomic.Pointer[DialFunc]

// Set задаёт (nil — снимает) дозвон для проб.
func Set(f DialFunc) {
	if f == nil {
		dial.Store(nil)
		return
	}
	dial.Store(&f)
}

// Get — текущий дозвон или nil.
func Get() DialFunc {
	if p := dial.Load(); p != nil {
		return *p
	}
	return nil
}
