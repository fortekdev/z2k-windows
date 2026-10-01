//go:build !linux && !windows

package edgepick

import "syscall"

func bindToDevice(string) func(string, string, syscall.RawConn) error { return nil }
