//go:build windows

package tundev

import (
	"errors"
	"fmt"
	"net"
	"net/netip"

	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"
)

// WindowsName — имя адаптера Wintun по умолчанию (флаг --tun-name).
const WindowsName = "z2k-warp"

// Metric — метрика интерфейса. Высокая намеренно: адаптер не должен
// выигрывать ни у кого «случайно» — маршруты через него ставит приложение
// (Electron) по префиксам, а они специфичнее любого чужого маршрута.
const Metric = 500

// Exists — есть ли интерфейс с таким именем.
func Exists(_ Runner, name string) bool {
	_, err := net.InterfaceByName(name)
	return err == nil
}

// Create — адаптер Wintun (wintun.dll рядом с exe). Адаптер, созданный
// процессом, Wintun удаляет при Close и при смерти процесса.
func Create(name string, mtu int) (tun.Device, error) {
	return tun.CreateTUN(name, mtu)
}

type luider interface{ LUID() uint64 }

// Configure по имени на Windows невозможен без устройства — см. ConfigureDevice.
func Configure(Runner, string, string, int) error {
	return errors.New("tundev: Configure without device is not supported on windows")
}

// ConfigureDevice — адрес /32, MTU и метрика через LUID API (winipcfg).
// НИ МАРШРУТА ПО УМОЛЧАНИЮ, НИ DNS: маршрутизацией управляет приложение.
// Устройство без LUID (тестовая заглушка) — не настраиваем.
func ConfigureDevice(_ Runner, dev tun.Device, name, addrV4 string, mtu int) error {
	l, ok := dev.(luider)
	if !ok {
		return nil
	}
	luid := winipcfg.LUID(l.LUID())
	addr, err := netip.ParseAddr(addrV4)
	if err != nil || !addr.Is4() {
		return fmt.Errorf("bad v4 address %q", addrV4)
	}
	if err := setAddress(luid, addr); err != nil {
		return err
	}
	// IPv4 — обязательно; IPv6 на адаптере есть (link-local), но адреса и
	// маршрутов у нас нет, поэтому ошибку по v6 не считаем фатальной.
	for _, fam := range []winipcfg.AddressFamily{windows.AF_INET, windows.AF_INET6} {
		ipif, err := luid.IPInterface(fam)
		if err != nil {
			if fam == windows.AF_INET {
				return fmt.Errorf("get ip interface: %w", err)
			}
			continue
		}
		ipif.NLMTU = uint32(mtu)
		ipif.UseAutomaticMetric = false
		ipif.Metric = Metric
		ipif.DadTransmits = 0
		ipif.RouterDiscoveryBehavior = winipcfg.RouterDiscoveryDisabled
		if fam == windows.AF_INET {
			// SetIpInterfaceEntry для IPv4 отказывает при ненулевом значении.
			ipif.SitePrefixLength = 0
		}
		if err := ipif.Set(); err != nil && fam == windows.AF_INET {
			return fmt.Errorf("set ip interface: %w", err)
		}
	}
	return nil
}

// setAddress ставит addr/32 на адаптер. Адрес уже на НАШЕМ адаптере
// (сохранённая конфигурация того же GUID) — успех, как «File exists» на
// Linux. На ДРУГОМ интерфейсе — AddrConflictError: Windows не даст поставить
// тот же адрес второй раз, а чужой туннель трогать нельзя.
func setAddress(luid winipcfg.LUID, addr netip.Addr) error {
	if owner, ok := addrOwner(addr); ok {
		if owner == luid {
			return nil
		}
		return &AddrConflictError{Addr: addr.String(), Alias: aliasOf(owner)}
	}
	err := luid.SetIPAddressesForFamily(windows.AF_INET, []netip.Prefix{netip.PrefixFrom(addr, 32)})
	if err == nil {
		return nil
	}
	if errors.Is(err, windows.ERROR_OBJECT_ALREADY_EXISTS) {
		if owner, ok := addrOwner(addr); ok {
			if owner == luid {
				return nil
			}
			return &AddrConflictError{Addr: addr.String(), Alias: aliasOf(owner)}
		}
		return &AddrConflictError{Addr: addr.String(), Alias: "?"}
	}
	return fmt.Errorf("set address: %w", err)
}

// addrOwner — LUID интерфейса, на котором стоит addr.
func addrOwner(addr netip.Addr) (winipcfg.LUID, bool) {
	rows, err := winipcfg.GetUnicastIPAddressTable(windows.AF_INET)
	if err != nil {
		return 0, false
	}
	for i := range rows {
		if rows[i].Address.Addr() == addr {
			return rows[i].InterfaceLUID, true
		}
	}
	return 0, false
}

func aliasOf(luid winipcfg.LUID) string {
	if row, err := luid.Interface(); err == nil {
		if a := row.Alias(); a != "" {
			return a
		}
		return fmt.Sprintf("ifindex %d", row.InterfaceIndex)
	}
	return fmt.Sprintf("luid %d", uint64(luid))
}

// Teardown на Windows не нужен: адаптер удаляется при закрытии устройства.
func Teardown(Runner, string) error { return nil }

// Info — фактическое имя адаптера (Windows может дать «z2k-warp 1», если
// имя занято), индекс интерфейса (для `route add ... IF n` / New-NetRoute
// -InterfaceIndex) и LUID.
func Info(dev tun.Device, name string) (alias string, ifIndex int, luid uint64) {
	if l, ok := dev.(luider); ok {
		luid = l.LUID()
		if row, err := winipcfg.LUID(luid).Interface(); err == nil {
			return row.Alias(), int(row.InterfaceIndex), luid
		}
	}
	if ifc, err := net.InterfaceByName(name); err == nil {
		ifIndex = ifc.Index
	}
	return "", ifIndex, luid
}
