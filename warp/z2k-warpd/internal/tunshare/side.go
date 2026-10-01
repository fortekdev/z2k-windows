package tunshare

import (
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/tun"
)

// ВТОРОЙ ПОТРЕБИТЕЛЬ ТУННЕЛЯ — userspace-стек для проб (см. internal/probenet).
//
// Пакеты, которые стек отправляет, уходят в текущий транспорт так же, как
// пакеты из ОС. Ответы транспорта на ЕГО потоки (запомненные по 5-кортежу
// при отправке) идут в стек, а не в устройство: ОС о них не знает и ответила
// бы RST. Всё остальное — в устройство, как раньше. Без AttachSide поведение
// Shared не меняется ни на байт.

const sideFlowTTL = 2 * time.Minute

type flowKey struct {
	proto  uint8
	remote [4]byte
	rport  uint16
	lport  uint16
}

type sideState struct {
	dev   tun.Device
	mu    sync.Mutex
	flows map[flowKey]time.Time
}

// AttachSide подключает side (tun.Device стека). Закрывать side — забота
// вызывающего; после закрытия его читающая горутина завершится сама.
func (s *Shared) AttachSide(side tun.Device) {
	st := &sideState{dev: side, flows: make(map[flowKey]time.Time)}
	s.mu.Lock()
	s.side = st
	s.mu.Unlock()
	go s.sideReader(st)
}

// DetachSide отключает стек: дальше все пакеты идут в устройство.
func (s *Shared) DetachSide() {
	s.mu.Lock()
	s.side = nil
	s.mu.Unlock()
}

func (s *Shared) sideReader(st *sideState) {
	bufs := [][]byte{make([]byte, s.offset+readBuf)}
	sizes := make([]int, 1)
	for {
		n, err := st.dev.Read(bufs, sizes, s.offset)
		if err != nil {
			return
		}
		if n == 0 || sizes[0] == 0 {
			continue
		}
		pkt := bufs[0][s.offset : s.offset+sizes[0]]
		if k, ok := outKey(pkt); ok {
			st.remember(k)
		}
		s.mu.Lock()
		h := s.cur
		s.mu.Unlock()
		if h == nil {
			continue
		}
		b := s.pool.Get().([]byte)
		if cap(b) < s.offset+sizes[0] {
			b = make([]byte, s.offset+sizes[0])
		}
		b = b[:s.offset+sizes[0]]
		copy(b[s.offset:], pkt)
		select {
		case h.q <- packet{buf: b, size: sizes[0]}:
		default:
			s.pool.Put(b)
		}
	}
}

func (st *sideState) remember(k flowKey) {
	now := time.Now()
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.flows) > 256 {
		for fk, t := range st.flows {
			if now.Sub(t) > sideFlowTTL {
				delete(st.flows, fk)
			}
		}
	}
	st.flows[k] = now
}

func (st *sideState) owns(pkt []byte) bool {
	k, ok := inKey(pkt)
	if !ok {
		return false
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	t, ok := st.flows[k]
	if !ok {
		return false
	}
	if time.Since(t) > sideFlowTTL {
		delete(st.flows, k)
		return false
	}
	return true
}

// l4 разбирает IPv4 TCP/UDP без фрагментации: протокол, адреса, порты.
func l4(p []byte) (proto uint8, src, dst [4]byte, sport, dport uint16, ok bool) {
	if len(p) < 20 || p[0]>>4 != 4 {
		return
	}
	ihl := int(p[0]&0x0f) * 4
	proto = p[9]
	if (proto != 6 && proto != 17) || ihl < 20 || len(p) < ihl+4 {
		return
	}
	// Не первый фрагмент — портов в нём нет.
	if (uint16(p[6]&0x1f)<<8 | uint16(p[7])) != 0 {
		return
	}
	copy(src[:], p[12:16])
	copy(dst[:], p[16:20])
	sport = uint16(p[ihl])<<8 | uint16(p[ihl+1])
	dport = uint16(p[ihl+2])<<8 | uint16(p[ihl+3])
	return proto, src, dst, sport, dport, true
}

// outKey — ключ потока по пакету, который стек отправляет наружу.
func outKey(p []byte) (flowKey, bool) {
	proto, _, dst, sport, dport, ok := l4(p)
	return flowKey{proto: proto, remote: dst, rport: dport, lport: sport}, ok
}

// inKey — ключ потока по пакету, пришедшему из туннеля.
func inKey(p []byte) (flowKey, bool) {
	proto, src, _, sport, dport, ok := l4(p)
	return flowKey{proto: proto, remote: src, rport: sport, lport: dport}, ok
}
