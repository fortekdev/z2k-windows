//go:build windows

package engine

import (
	"context"
	"fmt"
	"net"
	"net/netip"

	"golang.zx2c4.com/wireguard/tun/netstack"

	"github.com/necronicle/z2k/z2k-warpd/internal/probenet"
)

// attachProbeStack — userspace-стек с адресом туннеля для проб (health,
// edgepick): на Windows сокет ОС нельзя пустить через адаптер без маршрута,
// а маршрутами управляет приложение. См. internal/probenet.
func (e *Engine) attachProbeStack(addrV4 string) error {
	addr, err := netip.ParseAddr(addrV4)
	if err != nil {
		return fmt.Errorf("probe stack: %w", err)
	}
	dev, tnet, err := netstack.CreateNetTUN([]netip.Addr{addr}, nil, MTU)
	if err != nil {
		return fmt.Errorf("probe stack: %w", err)
	}
	e.tunDev.AttachSide(dev)
	e.probeStack = dev
	probenet.Set(func(ctx context.Context, network, address string) (net.Conn, error) {
		ap, err := netip.ParseAddrPort(address)
		if err != nil {
			return nil, fmt.Errorf("probe stack: %s: нужен адрес IP:порт", address)
		}
		switch network {
		case "tcp", "tcp4":
			return tnet.DialContextTCPAddrPort(ctx, ap)
		case "udp", "udp4":
			return tnet.DialUDPAddrPort(netip.AddrPort{}, ap)
		}
		return nil, fmt.Errorf("probe stack: сеть %q не поддерживается", network)
	})
	return nil
}

func (e *Engine) detachProbeStack() {
	if e.probeStack == nil {
		return
	}
	probenet.Set(nil)
	e.tunDev.DetachSide()
	e.probeStack.Close()
	e.probeStack = nil
}
