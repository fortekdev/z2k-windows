-- Тест z2k-win-dnsfix.lua на LuaJIT движка: npm run test:lua
-- (winws2 --intercept=0 выполняет только --lua-init и выходит)
local function name(s)
	local out = ""
	for label in s:gmatch("[^.]+") do out = out .. string.char(#label) .. label end
	return out .. "\0"
end
local function a_records(p)
	-- все rdata длиной 4 после поля rdlength=0x0004 у записей типа A
	local t, pos = {}, 1
	while true do
		local i = p:find("\0\1\0\1", pos, true)
		if not i then break end
		local rdlen = p:byte(i + 8) * 256 + p:byte(i + 9)
		if rdlen == 4 then t[#t + 1] = table.concat({ p:byte(i + 10, i + 13) }, ".") end
		pos = i + 1
	end
	return table.concat(t, ",")
end

local hdr = "\18\52\129\128\0\1\0\3\0\0\0\0"
local q = name("www.instagram.com") .. "\0\1\0\1"
local cname_rd = "\5z-p42\9instagram\4c10r\192\16"
local cname = "\192\12\0\5\0\1\0\0\14\16" .. string.char(0, #cname_rd) .. cname_rd
local a1 = "\192\35\0\1\0\1\0\0\0\60\0\4" .. string.char(157, 240, 205, 174)
local a2 = "\192\35\0\1\0\1\0\0\0\60\0\4" .. string.char(8, 8, 8, 8)
local pkt = hdr .. q .. cname .. a1 .. a2
local map = { [string.char(157, 240, 205, 174)] = string.char(57, 144, 248, 34) }

local fails = 0
local function check(label, cond) print((cond and "PASS " or "FAIL ") .. label); if not cond then fails = fails + 1 end end

local res = z2k_dnsfix_apply(pkt, map)
check("ответ изменён", res ~= nil)
check("длина не изменилась", res and #res == #pkt)
check("A 157.240.205.174 → 57.144.248.34, чужая A не тронута", res and a_records(res) == "57.144.248.34,8.8.8.8")
check("остальные байты совпадают", res and res:sub(1, #pkt - 20) == pkt:sub(1, #pkt - 20))
check("без ответов — nil", z2k_dnsfix_apply(hdr:sub(1, 6) .. "\0\0\0\0\0\0" .. q, map) == nil)
check("нет совпадений — nil", z2k_dnsfix_apply(hdr .. q .. cname .. a2 .. a2, map) == nil)
check("мусор — nil без ошибок", z2k_dnsfix_apply("\0\0\0\0\0\1\0\9\0\0\0\0\63abc", map) == nil)
check("обрезанный пакет — nil без ошибок", z2k_dnsfix_apply(pkt:sub(1, 70), map) == nil)
print(fails == 0 and "ALL PASS" or ("FAILED " .. fails))
