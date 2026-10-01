//go:build windows

package edgepick

import (
	"encoding/binary"
	"fmt"
	"net"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// IP_UNICAST_IF / IPV6_UNICAST_IF из ws2ipdef.h (в x/sys/windows их нет).
const (
	ipUnicastIf   = 31
	ipv6UnicastIf = 31
)

// bindToDevice на Windows — IP_UNICAST_IF: сокет уходит через интерфейс
// туннеля по индексу (аналог SO_BINDTODEVICE / curl --interface), поэтому
// проба не может утечь мимо туннеля и дать ложный «жив».
func bindToDevice(iface string) func(string, string, syscall.RawConn) error {
	return func(network, _ string, raw syscall.RawConn) error {
		ifc, err := net.InterfaceByName(iface)
		if err != nil {
			return fmt.Errorf("bind %s: %w", iface, err)
		}
		var sockErr error
		if err := raw.Control(func(fd uintptr) {
			if strings.HasSuffix(network, "6") {
				sockErr = windows.SetsockoptInt(windows.Handle(fd), windows.IPPROTO_IPV6, ipv6UnicastIf, ifc.Index)
				return
			}
			// Для IPv4 индекс — в сетевом порядке байт.
			var be [4]byte
			binary.BigEndian.PutUint32(be[:], uint32(ifc.Index))
			sockErr = windows.SetsockoptInt(windows.Handle(fd), windows.IPPROTO_IP, ipUnicastIf, int(binary.LittleEndian.Uint32(be[:])))
		}); err != nil {
			return err
		}
		return sockErr
	}
}
