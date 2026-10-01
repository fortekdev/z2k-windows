package main

// Владелец TCP-соединения по таблице GetExtendedTcpTable. Нужен, чтобы не перехватывать
// собственные соединения z2k (прокси сам ходит к IP Telegram — иначе получится петля).

import (
	"encoding/binary"
	"net/netip"
	"syscall"
	"unsafe"
)

var procGetExtendedTcpTable = syscall.NewLazyDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

const (
	tcpTableOwnerPidAll = 5
	afInet              = 2
	afInet6             = 23
	errInsufficientBuf  = 122
)

func tcpTable(af uintptr) []byte {
	size := uint32(64 * 1024)
	for i := 0; i < 4; i++ {
		buf := make([]byte, size)
		r, _, _ := procGetExtendedTcpTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, af, tcpTableOwnerPidAll, 0)
		if r == 0 {
			return buf
		}
		if r != errInsufficientBuf {
			return nil
		}
		size += 16 * 1024 // таблица могла вырасти между вызовами
	}
	return nil
}

// ownerPid ищет процесс, владеющий соединением localPort → remote:remotePort.
func ownerPid(localPort uint16, remote netip.Addr, remotePort uint16) (uint32, bool) {
	if remote.Is4() {
		t := tcpTable(afInet)
		if len(t) < 4 {
			return 0, false
		}
		n := int(binary.LittleEndian.Uint32(t))
		ra := remote.As4()
		// MIB_TCPROW_OWNER_PID: state, localAddr, localPort, remoteAddr, remotePort, pid — по 4 байта
		for i := 0; i < n; i++ {
			off := 4 + i*24
			if off+24 > len(t) {
				break
			}
			row := t[off : off+24]
			if binary.BigEndian.Uint16(row[8:10]) == localPort && binary.BigEndian.Uint16(row[16:18]) == remotePort && [4]byte(row[12:16]) == ra {
				return binary.LittleEndian.Uint32(row[20:24]), true
			}
		}
		return 0, false
	}
	t := tcpTable(afInet6)
	if len(t) < 4 {
		return 0, false
	}
	n := int(binary.LittleEndian.Uint32(t))
	ra := remote.As16()
	// MIB_TCP6ROW_OWNER_PID: localAddr[16], scope, localPort, remoteAddr[16], scope, remotePort, state, pid
	for i := 0; i < n; i++ {
		off := 4 + i*56
		if off+56 > len(t) {
			break
		}
		row := t[off : off+56]
		if binary.BigEndian.Uint16(row[20:22]) == localPort && binary.BigEndian.Uint16(row[44:46]) == remotePort && [16]byte(row[24:40]) == ra {
			return binary.LittleEndian.Uint32(row[52:56]), true
		}
	}
	return 0, false
}
