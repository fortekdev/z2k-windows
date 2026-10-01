//go:build !windows

package nat

import (
	"fmt"
	"strings"
)

// Ensure ставит недостающие правила (-C || -A).
func Ensure(run Runner, iface string, mss int) error {
	for _, r := range Rules(iface, mss) {
		if _, err := run("iptables", args("-C", r)...); err == nil {
			continue
		}
		add := args("-A", r)
		if r[0] == "filter" {
			add = insertArgs(r)
		}
		if out, err := run("iptables", add...); err != nil {
			return fmt.Errorf("iptables -t %s %s %s: %s", r[0], add[3], r[1], strings.TrimSpace(out))
		}
	}
	return nil
}

// Remove удаляет правила, пока -C их находит (дубликаты от старых запусков).
func Remove(run Runner, iface string, mss int) error {
	for _, r := range Rules(iface, mss) {
		for i := 0; i < 16; i++ {
			if _, err := run("iptables", args("-C", r)...); err != nil {
				break
			}
			if _, err := run("iptables", args("-D", r)...); err != nil {
				break
			}
		}
	}
	return nil
}
