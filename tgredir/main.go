// z2k-tgredir — прозрачный перехват Telegram на Windows.
//
// Аналог z2k-tg-redirect.sh из z2k (iptables -t nat … --match-set z2k_tg_dc dst -j REDIRECT
// --to-port 1443): исходящие TCP-соединения ЛЮБЫХ программ (Telegram Desktop без настроек прокси,
// веб-версия в браузере, Unigram …) к подсетям Telegram «отражаются» WinDivert'ом на локальный
// порт этого процесса — схема streamdump из примеров WinDivert: адреса меняются местами и пакет
// уходит обратно в стек как входящий. Отсюда соединение передаётся в SOCKS5-прокси z2k с исходным
// адресом назначения, а прокси уже сам выбирает путь (WebSocket Telegram / свой Cloudflare Worker /
// напрямую).
//
// Соединения процессов из --exclude-pid (сам z2k: его прокси ходит к тем же IP) не трогаются,
// иначе получится петля. Владелец определяется по SYN через GetExtendedTcpTable.
//
// Протокол со стороны z2k: stdout построчно, «READY port=N» после запуска, далее
// «INFO|WARN|DEBUG текст». Процесс завершается вместе с --parent-pid.
package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	tcpFin = 0x01
	tcpSyn = 0x02
	tcpRst = 0x04
	tcpAck = 0x10

	closedTTL = 90 * time.Second // после FIN/RST — дождаться последних ACK
	idleTTL   = 2 * time.Hour    // Telegram держит соединения долго и пингует их
)

var version = "dev" // -X main.version (scripts/build-tgredir.mjs)

var (
	out     = bufio.NewWriter(os.Stdout)
	outMu   sync.Mutex
	verbose bool
)

func logf(level, format string, a ...any) {
	if level == "DEBUG" && !verbose {
		return
	}
	outMu.Lock()
	defer outMu.Unlock()
	fmt.Fprintf(out, "%s %s\n", level, fmt.Sprintf(format, a...))
	out.Flush()
}

// ---------- таблица соединений ----------

type flowKey struct {
	ip   netip.Addr // IP Telegram
	port uint16     // локальный порт клиента
}

type flow struct {
	dport    uint16 // исходный порт назначения (443/80/5222)
	redirect bool
	closing  bool
	seen     time.Time
}

type flowTable struct {
	mu sync.Mutex
	m  map[flowKey]*flow
}

func (t *flowTable) put(k flowKey, f *flow) {
	t.mu.Lock()
	t.m[k] = f
	t.mu.Unlock()
}

// touch возвращает копию записи и отмечает активность/закрытие.
func (t *flowTable) touch(k flowKey, flags byte) (flow, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	f := t.m[k]
	if f == nil {
		return flow{}, false
	}
	f.seen = time.Now()
	if flags&(tcpFin|tcpRst) != 0 {
		f.closing = true
	}
	return *f, true
}

func (t *flowTable) sweep() (active int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	for k, f := range t.m {
		age := now.Sub(f.seen)
		if (f.closing && age > closedTTL) || age > idleTTL {
			delete(t.m, k)
		} else if f.redirect && !f.closing {
			active++
		}
	}
	return active
}

// ---------- разбор пакета ----------

type pktInfo struct {
	v6       bool
	src, dst netip.Addr
	tcp      []byte
}

func parse(p []byte) (pi pktInfo, ok bool) {
	if len(p) < 20 {
		return pi, false
	}
	switch p[0] >> 4 {
	case 4:
		ihl := int(p[0]&0x0f) * 4
		if p[9] != 6 || ihl < 20 || len(p) < ihl+20 {
			return pi, false
		}
		pi.src = netip.AddrFrom4([4]byte(p[12:16]))
		pi.dst = netip.AddrFrom4([4]byte(p[16:20]))
		pi.tcp = p[ihl:]
	case 6:
		// Telegram не шлёт заголовков расширения; прочее фильтр WinDivert всё равно отдаёт как tcp
		if len(p) < 60 || p[6] != 6 {
			return pi, false
		}
		pi.v6 = true
		pi.src = netip.AddrFrom16([16]byte(p[8:24]))
		pi.dst = netip.AddrFrom16([16]byte(p[24:40]))
		pi.tcp = p[40:]
	default:
		return pi, false
	}
	return pi, true
}

func swapAddrs(p []byte, v6 bool) {
	a, b, n := 12, 16, 4
	if v6 {
		a, b, n = 8, 24, 16
	}
	var tmp [16]byte
	copy(tmp[:n], p[a:a+n])
	copy(p[a:a+n], p[b:b+n])
	copy(p[b:b+n], tmp[:n])
}

// ---------- перехват ----------

type redirector struct {
	d         *divert
	port      uint16 // порт локального приёмника
	ports     map[uint16]bool
	exclude   map[uint32]bool
	flows     *flowTable
	stopping  atomic.Bool
	names     sync.Map        // pid → имя exe (для журнала)
	announced map[uint32]bool // о каких процессах уже сообщили (только из цикла пакетов)
}

// decide — новый SYN: чей он и надо ли его перехватывать. known=false — владелец не найден.
func (r *redirector) decide(k flowKey, dport uint16) (f flow, known bool) {
	f = flow{dport: dport, seen: time.Now()}
	var pid uint32
	// Соединение обычно уже в таблице (SYN_SENT), но изредка появляется чуть позже SYN
	for i, wait := range []time.Duration{0, time.Millisecond, 2 * time.Millisecond, 4 * time.Millisecond} {
		if i > 0 {
			time.Sleep(wait)
		}
		if pid, known = ownerPid(k.port, k.ip, dport); known {
			break
		}
	}
	if !known {
		// Без перехвата SYN всё равно упрётся в блокировку, а наше же соединение перехватывать нельзя —
		// отбрасываем: клиент повторит SYN через ~1 с, и тогда владелец уже найдётся.
		logf("DEBUG", "владелец соединения :%d → %s пока не виден — SYN отброшен до повтора", k.port, netip.AddrPortFrom(k.ip, dport))
		return f, false
	}
	if !r.exclude[pid] { // собственные соединения z2k (прокси) — мимо
		f.redirect = true
		if !r.announced[pid] {
			r.announced[pid] = true
			logf("INFO", "перехвачено: %s (pid %d) → %s", r.procName(pid), pid, netip.AddrPortFrom(k.ip, dport))
		} else {
			logf("DEBUG", "перехват %s (pid %d) → %s", r.procName(pid), pid, netip.AddrPortFrom(k.ip, dport))
		}
	}
	stored := f
	r.flows.put(k, &stored)
	return f, true
}

func (r *redirector) procName(pid uint32) string {
	if v, ok := r.names.Load(pid); ok {
		return v.(string)
	}
	name := "?"
	if h, err := syscall.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid); err == nil {
		buf := make([]uint16, 520)
		n := uint32(len(buf))
		if r, _, _ := procQueryFullProcessImageName.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); r != 0 {
			name = filepath.Base(syscall.UTF16ToString(buf[:n]))
		}
		syscall.CloseHandle(h)
	}
	r.names.Store(pid, name)
	return name
}

var procQueryFullProcessImageName = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryFullProcessImageNameW")

// handle меняет пакет на месте. modified — пересчитать контрольные суммы; drop — не отправлять.
func (r *redirector) handle(p []byte, addr *divertAddr) (modified, drop bool) {
	if !addr.outbound() {
		return false, false
	}
	pi, ok := parse(p)
	if !ok || len(pi.tcp) < 20 {
		return false, false
	}
	sport := binary.BigEndian.Uint16(pi.tcp[0:2])
	dport := binary.BigEndian.Uint16(pi.tcp[2:4])
	flags := pi.tcp[13]

	// Ответ нашего приёмника клиенту: L:port → T:lp  ⇒  T:dport → L:lp (входящий)
	if sport == r.port {
		f, ok := r.flows.touch(flowKey{pi.dst, dport}, flags)
		if !ok || !f.redirect {
			return false, true
		}
		binary.BigEndian.PutUint16(pi.tcp[0:2], f.dport)
		swapAddrs(p, pi.v6)
		addr.setOutbound(false)
		return true, false
	}
	if !r.ports[dport] {
		return false, false
	}
	// Клиент → Telegram: L:lp → T:dport  ⇒  T:lp → L:port (входящий)
	k := flowKey{pi.dst, sport}
	var f flow
	if flags&tcpSyn != 0 && flags&tcpAck == 0 {
		if f, ok = r.decide(k, dport); !ok {
			return false, true
		}
	} else if f, ok = r.flows.touch(k, flags); !ok {
		return false, false // соединение открыто до запуска перехвата
	}
	if !f.redirect {
		return false, false
	}
	binary.BigEndian.PutUint16(pi.tcp[2:4], r.port)
	swapAddrs(p, pi.v6)
	addr.setOutbound(false)
	return true, false
}

func (r *redirector) loop() error {
	buf := make([]byte, maxPacketSize)
	var addr divertAddr
	for {
		n, err := r.d.Recv(buf, &addr)
		if err != nil {
			if r.stopping.Load() {
				return nil
			}
			var en syscall.Errno
			if errors.As(err, &en) && en == 122 { // ERROR_INSUFFICIENT_BUFFER — пакет больше буфера, пропускаем
				continue
			}
			return fmt.Errorf("WinDivertRecv: %w", err)
		}
		pkt := buf[:n]
		modified, drop := r.handle(pkt, &addr)
		if drop {
			continue
		}
		if modified {
			r.d.CalcChecksums(pkt, &addr)
		}
		if err := r.d.Send(pkt, &addr); err != nil {
			logf("DEBUG", "WinDivertSend: %v", err)
		}
	}
}

// ---------- приёмник → SOCKS5 ----------

type socksCfg struct {
	addr, user, pass string
}

func (r *redirector) serve(ln net.Listener, s socksCfg) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if r.stopping.Load() {
				return
			}
			logf("WARN", "accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go r.serveConn(c, s)
	}
}

func (r *redirector) serveConn(c net.Conn, s socksCfg) {
	ra, _ := c.RemoteAddr().(*net.TCPAddr)
	if ra == nil {
		c.Close()
		return
	}
	ip, _ := netip.AddrFromSlice(ra.IP)
	f, ok := r.flows.touch(flowKey{ip.Unmap(), uint16(ra.Port)}, 0)
	if !ok || !f.redirect {
		// не наше отражённое соединение (например, кто-то из локальной сети) — не обслуживаем
		c.Close()
		return
	}
	dst := netip.AddrPortFrom(ip.Unmap(), f.dport)
	up, err := net.DialTimeout("tcp", s.addr, 5*time.Second)
	if err == nil {
		err = socksConnect(up, dst, s.user, s.pass)
	}
	if err != nil {
		logf("WARN", "%s: прокси z2k недоступен: %v", dst, err)
		if up != nil {
			up.Close()
		}
		c.Close()
		return
	}
	pipe(c, up)
}

func socksConnect(c net.Conn, dst netip.AddrPort, user, pass string) error {
	c.SetDeadline(time.Now().Add(10 * time.Second))
	defer c.SetDeadline(time.Time{})
	if user != "" {
		c.Write([]byte{5, 1, 2})
	} else {
		c.Write([]byte{5, 1, 0})
	}
	var b [4]byte
	if _, err := io.ReadFull(c, b[:2]); err != nil {
		return err
	}
	switch b[1] {
	case 0:
	case 2:
		msg := append([]byte{1, byte(len(user))}, user...)
		msg = append(append(msg, byte(len(pass))), pass...)
		c.Write(msg)
		if _, err := io.ReadFull(c, b[:2]); err != nil {
			return err
		}
		if b[1] != 0 {
			return errors.New("неверный логин/пароль SOCKS")
		}
	default:
		return fmt.Errorf("SOCKS: метод %d", b[1])
	}
	req := []byte{5, 1, 0}
	if dst.Addr().Is4() {
		a := dst.Addr().As4()
		req = append(append(req, 1), a[:]...)
	} else {
		a := dst.Addr().As16()
		req = append(append(req, 4), a[:]...)
	}
	req = binary.BigEndian.AppendUint16(req, dst.Port())
	c.Write(req)
	if _, err := io.ReadFull(c, b[:4]); err != nil {
		return err
	}
	if b[1] != 0 {
		return fmt.Errorf("SOCKS: отказ %d", b[1])
	}
	skip := map[byte]int{1: 4 + 2, 4: 16 + 2}[b[3]]
	if b[3] == 3 {
		var l [1]byte
		if _, err := io.ReadFull(c, l[:]); err != nil {
			return err
		}
		skip = int(l[0]) + 2
	}
	_, err := io.CopyN(io.Discard, c, int64(skip))
	return err
}

func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		io.Copy(dst, src)
		if tc, ok := dst.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	// вторая сторона обычно закрывается следом; не держим полуоткрытое соединение вечно
	deadline := time.Now().Add(30 * time.Second)
	a.SetDeadline(deadline)
	b.SetDeadline(deadline)
	<-done
	a.Close()
	b.Close()
}

// ---------- фильтр ----------

func lastAddr(p netip.Prefix) netip.Addr {
	b := p.Masked().Addr().AsSlice()
	for i := p.Bits(); i < len(b)*8; i++ {
		b[i/8] |= 0x80 >> (i % 8)
	}
	a, _ := netip.AddrFromSlice(b)
	return a
}

func buildFilter(nets []netip.Prefix, ports []uint16, listenPort uint16) string {
	var v4, v6 []string
	for _, p := range nets {
		lo, hi := p.Masked().Addr(), lastAddr(p)
		if p.Addr().Is4() {
			v4 = append(v4, fmt.Sprintf("(ip.DstAddr >= %s and ip.DstAddr <= %s)", lo, hi))
		} else {
			v6 = append(v6, fmt.Sprintf("(ipv6.DstAddr >= %s and ipv6.DstAddr <= %s)", lo, hi))
		}
	}
	var dst []string
	if len(v4) > 0 {
		dst = append(dst, "(ip and ("+strings.Join(v4, " or ")+"))")
	}
	if len(v6) > 0 {
		dst = append(dst, "(ipv6 and ("+strings.Join(v6, " or ")+"))")
	}
	pp := []string{fmt.Sprintf("tcp.SrcPort == %d", listenPort)}
	for _, p := range ports {
		pp = append(pp, fmt.Sprintf("tcp.DstPort == %d", p))
	}
	return fmt.Sprintf("outbound and !loopback and !impostor and tcp and (%s) and (%s)", strings.Join(dst, " or "), strings.Join(pp, " or "))
}

// ---------- main ----------

func splitList(s string) []string {
	var out []string
	for _, x := range strings.Split(s, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

func main() {
	exe, _ := os.Executable()
	dll := flag.String("dll", filepath.Join(filepath.Dir(exe), "WinDivert.dll"), "путь к WinDivert.dll")
	socks := flag.String("socks", "127.0.0.1:10808", "SOCKS5-прокси z2k")
	netsArg := flag.String("nets", "", "подсети Telegram через запятую (CIDR)")
	portsArg := flag.String("ports", "443,80,5222", "перехватываемые порты назначения")
	excludeArg := flag.String("exclude-pid", "", "PID процессов, чьи соединения не трогать")
	parentPid := flag.Int("parent-pid", 0, "завершиться вместе с этим процессом")
	priority := flag.Int("priority", 1000, "приоритет WinDivert (выше winws2, у него 0)")
	flag.BoolVar(&verbose, "v", false, "подробный журнал")
	flag.Parse()

	fail := func(format string, a ...any) {
		logf("ERROR", format, a...)
		os.Exit(1)
	}

	var nets []netip.Prefix
	for _, s := range splitList(*netsArg) {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			fail("подсеть %q: %v", s, err)
		}
		nets = append(nets, p)
	}
	if len(nets) == 0 {
		fail("не заданы подсети (--nets)")
	}
	ports := map[uint16]bool{}
	var portList []uint16
	for _, s := range splitList(*portsArg) {
		n, err := strconv.ParseUint(s, 10, 16)
		if err != nil || n == 0 {
			fail("порт %q", s)
		}
		ports[uint16(n)] = true
		portList = append(portList, uint16(n))
	}
	exclude := map[uint32]bool{uint32(os.Getpid()): true}
	for _, s := range splitList(*excludeArg) {
		n, err := strconv.ParseUint(s, 10, 32)
		if err != nil {
			fail("pid %q", s)
		}
		exclude[uint32(n)] = true
	}

	// Двойной стек: [::]:0 принимает и IPv4. Порт выбирает система — конфликтов не бывает.
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		fail("приёмник: %v", err)
	}
	port := uint16(ln.Addr().(*net.TCPAddr).Port)

	filter := buildFilter(nets, portList, port)
	logf("DEBUG", "z2k-tgredir %s, фильтр WinDivert: %s", version, filter)
	d, err := openDivert(*dll, filter, int16(*priority))
	if err != nil {
		fail("%v", err)
	}
	r := &redirector{d: d, port: port, ports: ports, exclude: exclude, flows: &flowTable{m: map[flowKey]*flow{}}, announced: map[uint32]bool{}}

	stop := func() {
		if r.stopping.Swap(true) {
			return
		}
		d.Close()
		ln.Close()
	}
	if *parentPid > 0 {
		go func() {
			h, err := syscall.OpenProcess(0x00100000 /* SYNCHRONIZE */, false, uint32(*parentPid))
			if err == nil {
				syscall.WaitForSingleObject(h, syscall.INFINITE)
			}
			logf("INFO", "z2k завершился — перехват снят")
			stop()
			os.Exit(0)
		}()
	}

	go r.serve(ln, socksCfg{addr: *socks, user: os.Getenv("Z2K_SOCKS_USER"), pass: os.Getenv("Z2K_SOCKS_PASS")})
	go func() {
		last := -1
		for range time.Tick(30 * time.Second) {
			if n := r.flows.sweep(); n != last {
				last = n
				logf("STAT", "active=%d", n)
			}
		}
	}()

	logf("READY", "port=%d", port)
	if err := r.loop(); err != nil {
		fail("%v", err)
	}
}
