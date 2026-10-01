//go:build !windows

package tundev

import (
	"errors"
	"fmt"
	"strings"

	"golang.zx2c4.com/wireguard/tun"
)

// Exists — есть ли netdev с таким именем (через `ip link show`).
func Exists(run Runner, name string) bool {
	_, err := run("ip", "link", "show", "dev", name)
	return err == nil
}

// Create создаёт TUN-устройство с заданным именем и MTU.
func Create(name string, mtu int) (tun.Device, error) {
	return tun.CreateTUN(name, mtu)
}

// Configure — адрес /32, MTU, link up. Адрес «уже есть» — не ошибка.
func Configure(run Runner, name, addrV4 string, mtu int) error {
	if out, err := run("ip", "addr", "add", addrV4+"/32", "dev", name); err != nil {
		if !strings.Contains(out, "File exists") {
			return fmt.Errorf("ip addr add: %s", firstLine(out, err))
		}
	}
	if out, err := run("ip", "link", "set", "dev", name, "mtu", fmt.Sprint(mtu)); err != nil {
		return fmt.Errorf("ip link set mtu: %s", firstLine(out, err))
	}
	if out, err := run("ip", "link", "set", "dev", name, "up"); err != nil {
		return fmt.Errorf("ip link set up: %s", firstLine(out, err))
	}
	return nil
}

// Teardown опускает линк; само устройство исчезает при закрытии TUN.
func Teardown(run Runner, name string) error {
	if out, err := run("ip", "link", "set", "dev", name, "down"); err != nil {
		return errors.New(firstLine(out, err))
	}
	return nil
}

// ConfigureDevice — Configure для уже созданного устройства. На Linux
// устройство не нужно: всё делается командами ip по имени.
func ConfigureDevice(run Runner, _ tun.Device, name, addrV4 string, mtu int) error {
	return Configure(run, name, addrV4, mtu)
}

// Info — фактическое имя, индекс и LUID интерфейса для status.json. Это
// нужно только на Windows; на Linux пусто (status.json как был).
func Info(tun.Device, string) (alias string, ifIndex int, luid uint64) { return "", 0, 0 }
