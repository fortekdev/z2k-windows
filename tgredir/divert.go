package main

// Минимальная привязка к WinDivert.dll 2.x (та же библиотека и драйвер, что у winws2).

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const (
	layerNetwork  = 0
	addrSize      = 80 // sizeof(WINDIVERT_ADDRESS)
	flagsOffset   = 8  // UINT32 с битовыми полями Layer:8 Event:8 Sniffed Outbound Loopback Impostor IPv6 …
	outboundBit   = 1 << 17
	maxPacketSize = 0xFFFF + 40
)

type divertAddr [addrSize]byte

func (a *divertAddr) flags() uint32 {
	return *(*uint32)(unsafe.Pointer(&a[flagsOffset]))
}

func (a *divertAddr) setOutbound(out bool) {
	p := (*uint32)(unsafe.Pointer(&a[flagsOffset]))
	if out {
		*p |= outboundBit
	} else {
		*p &^= outboundBit
	}
}

func (a *divertAddr) outbound() bool { return a.flags()&outboundBit != 0 }

type divert struct {
	h                                 uintptr
	recv, send, csum, shutdown, close *syscall.Proc
}

func openDivert(dllPath, filter string, priority int16) (*divert, error) {
	dll, err := syscall.LoadDLL(dllPath)
	if err != nil {
		return nil, fmt.Errorf("загрузка %s: %w", dllPath, err)
	}
	find := func(name string) (*syscall.Proc, error) { return dll.FindProc(name) }
	open, err := find("WinDivertOpen")
	if err != nil {
		return nil, err
	}
	d := &divert{}
	for name, p := range map[string]**syscall.Proc{
		"WinDivertRecv": &d.recv, "WinDivertSend": &d.send, "WinDivertHelperCalcChecksums": &d.csum,
		"WinDivertShutdown": &d.shutdown, "WinDivertClose": &d.close,
	} {
		if *p, err = find(name); err != nil {
			return nil, err
		}
	}
	f, err := syscall.BytePtrFromString(filter)
	if err != nil {
		return nil, err
	}
	h, _, e := open.Call(uintptr(unsafe.Pointer(f)), layerNetwork, uintptr(priority), 0)
	if h == uintptr(syscall.InvalidHandle) {
		var en syscall.Errno
		if errors.As(e, &en) {
			switch en {
			case 5:
				return nil, errors.New("WinDivertOpen: нет прав администратора")
			case 87:
				return nil, fmt.Errorf("WinDivertOpen: ошибка в фильтре: %s", filter)
			case 2:
				return nil, errors.New("WinDivertOpen: не найден драйвер WinDivert64.sys рядом с WinDivert.dll")
			}
		}
		return nil, fmt.Errorf("WinDivertOpen: %w", e)
	}
	d.h = h
	return d, nil
}

func (d *divert) Recv(buf []byte, addr *divertAddr) (int, error) {
	var n uint32
	r, _, e := d.recv.Call(d.h, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(addr)))
	if r == 0 {
		return 0, e
	}
	return int(n), nil
}

func (d *divert) Send(pkt []byte, addr *divertAddr) error {
	var n uint32
	r, _, e := d.send.Call(d.h, uintptr(unsafe.Pointer(&pkt[0])), uintptr(len(pkt)), uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(addr)))
	if r == 0 {
		return e
	}
	return nil
}

func (d *divert) CalcChecksums(pkt []byte, addr *divertAddr) {
	d.csum.Call(uintptr(unsafe.Pointer(&pkt[0])), uintptr(len(pkt)), uintptr(unsafe.Pointer(addr)), 0)
}

// Shutdown прерывает Recv (WINDIVERT_SHUTDOWN_BOTH), Close освобождает хэндл.
func (d *divert) Close() {
	d.shutdown.Call(d.h, 3)
	d.close.Call(d.h)
}
