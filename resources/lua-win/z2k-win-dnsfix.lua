-- z2k-win-dnsfix.lua — подмена заблокированных по IP адресов в DNS-ответах (Windows-порт идеи z2k-insta-ip-refresh).
--
-- Провайдер отдаёт для instagram.com и т.п. адрес Meta, который заблокирован по IP целиком: TCP не устанавливается,
-- пакетный обход бессилен. z2k на роутере прописывает рабочие адреса в статический DNS; здесь системные файлы не
-- трогаются — движок сам меняет адрес в A-записи входящего DNS-ответа.
--
-- Карта «заблокированный IP → рабочий IP» — файл из переменной Z2K_DNSFIX_FILE, строки "a.b.c.d e.f.g.h".
-- Её готовит приложение (проверка доступности + адреса Meta из других стран), файл перечитывается не чаще раза в 10 с.
-- Длина пакета не меняется: заменяются 4 байта rdata, имена (в т.ч. сжатые) не трогаются.
--
-- Использование: --filter-udp=53 --filter-l7=dns --out-range=x --in-range=a --payload=dns_response --lua-desync=z2k_dns_rewrite

local MAP_FILE = os.getenv("Z2K_DNSFIX_FILE")
local map = {}
local map_size = 0
local loaded_at = -1

local function load_map()
	local now = os.time()
	if loaded_at >= 0 and now - loaded_at < 10 then return end
	loaded_at = now
	local m, n = {}, 0
	local f = MAP_FILE and io.open(MAP_FILE, "r")
	if f then
		for line in f:lines() do
			local a1, a2, a3, a4, b1, b2, b3, b4 = line:match("^%s*(%d+)%.(%d+)%.(%d+)%.(%d+)%s+(%d+)%.(%d+)%.(%d+)%.(%d+)")
			if a1 then
				m[string.char(tonumber(a1), tonumber(a2), tonumber(a3), tonumber(a4))] =
					string.char(tonumber(b1), tonumber(b2), tonumber(b3), tonumber(b4))
				n = n + 1
			end
		end
		f:close()
	end
	map, map_size = m, n
end

-- пропустить имя (метки или указатель сжатия); возвращает позицию после имени или nil
local function skip_name(p, pos)
	for _ = 1, 128 do
		local len = p:byte(pos)
		if not len then return nil end
		if len == 0 then return pos + 1 end
		if len >= 0xC0 then return pos + 2 end
		pos = pos + 1 + len
	end
	return nil
end

local function u16(p, pos)
	local a, b = p:byte(pos, pos + 1)
	if not b then return nil end
	return a * 256 + b
end

-- Чистая функция для тестов: ответ DNS + карта → изменённый ответ или nil
function z2k_dnsfix_apply(p, m)
	if not p or #p < 12 then return nil end
	local qd, an = u16(p, 5), u16(p, 7)
	if not qd or not an or an == 0 then return nil end
	local pos = 13
	for _ = 1, qd do
		pos = skip_name(p, pos)
		if not pos then return nil end
		pos = pos + 4
	end
	local out, last, changed = {}, 1, false
	for _ = 1, an do
		pos = skip_name(p, pos)
		if not pos or pos + 9 > #p then break end
		local typ, rdlen = u16(p, pos), u16(p, pos + 8)
		local rd = pos + 10
		if not typ or not rdlen or rd + rdlen - 1 > #p then break end
		if typ == 1 and rdlen == 4 then
			local repl = m[p:sub(rd, rd + 3)]
			if repl then
				out[#out + 1] = p:sub(last, rd - 1)
				out[#out + 1] = repl
				last = rd + 4
				changed = true
			end
		end
		pos = rd + rdlen
	end
	if not changed then return nil end
	out[#out + 1] = p:sub(last)
	return table.concat(out)
end

function z2k_dns_rewrite(ctx, desync)
	if not desync.dis.udp or desync.outgoing then return end
	load_map()
	if map_size == 0 then return end
	local res = z2k_dnsfix_apply(desync.dis.payload, map)
	if res then
		desync.dis.payload = res
		if b_debug then DLOG("z2k_dns_rewrite: адрес в DNS-ответе заменён") end
		return VERDICT_MODIFY
	end
end
