const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { getClientByChatId, isAllowedChatId } = require("./clients");

const app = express();
app.use(express.json());

const GREEN_API_ID = (process.env.GREEN_API_ID || "").trim();
const GREEN_API_TOKEN = (process.env.GREEN_API_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const inventoryCaches = {};
const INVENTORY_TTL_MS = 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const sheetUrl in inventoryCaches) {
    if (now - inventoryCaches[sheetUrl].ts > 24 * 60 * 60 * 1000) {
      delete inventoryCaches[sheetUrl];
    }
  }
}, 86400000);

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } 
      else { inQuotes = !inQuotes; }
      continue;
    }
    if (ch === "," && !inQuotes) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normalizeKey(k) {
  return String(k || "").trim().toLowerCase().replace(/\s+/g, "_").replace(/[^\w\u00C0-\u024F\u0590-\u05FF_]/g, "");
}

function splitPhotoUrls(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw.split(/[\s,|;\n\r]+/g).map((p) => p.trim()).filter((p) => /^https?:\/\/\S+/i.test(p));
}

function safeString(v) { return String(v == null ? "" : v).trim(); }

function parseNumberLoose(v) {
  const s = safeString(v).replace(/[, ]/g, "");
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function headerScore(headerNorm, patterns) {
  let score = 0;
  if (!patterns) return 0;
  for (const p of patterns) {
    if (headerNorm.includes(p)) score += 2;
    if (headerNorm === p) score += 3;
  }
  return score;
}

function detectFieldKeys(headers, fieldMapping) {
  const normMap = headers.map((h) => ({ orig: h, norm: normalizeKey(h) }));
  function pickBest(field) {
    let best = { orig: "", score: 0 };
    const patterns = fieldMapping && fieldMapping[field] ? fieldMapping[field] : [];
    for (const h of normMap) {
      const s = headerScore(h.norm, patterns);
      if (s > best.score) best = { orig: h.orig, score: s };
    }
    return best.score >= 3 ? best.orig : "";
  }
  return {
    modelKey: pickBest("model"),
    brandKey: pickBest("brand"),
    yearKey: pickBest("year"),
    priceKey: pickBest("price"),
    photosKey: pickBest("photos"),
  };
}

function hashId(s) {
  let h = 2166136261;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `item_${(h >>> 0).toString(16)}`;
}

function buildSearchableText(item) {
  const parts = [safeString(item.brand), safeString(item.model), safeString(item.year), safeString(item.price)];
  for (const k of Object.keys(item.details || {})) {
    parts.push(safeString(k), safeString(item.details[k]));
  }
  return parts.join(" ").toLowerCase();
}

function slimRow(rawRow, fieldKeys) {
  const details = {};
  const rawPhotos = [];
  const model = safeString(rawRow[fieldKeys.modelKey] || "");
  const brand = safeString(rawRow[fieldKeys.brandKey] || "");
  const year = safeString(rawRow[fieldKeys.yearKey] || "");
  const price = safeString(rawRow[fieldKeys.priceKey] || "");
  if (fieldKeys.photosKey) rawPhotos.push(...splitPhotoUrls(rawRow[fieldKeys.photosKey]));
  for (const k of Object.keys(rawRow || {})) {
    const v = safeString(rawRow[k]);
    if ([fieldKeys.modelKey, fieldKeys.brandKey, fieldKeys.yearKey, fieldKeys.priceKey, fieldKeys.photosKey].includes(k)) continue;
    const urls = splitPhotoUrls(v);
    if (urls.length) { rawPhotos.push(...urls); continue; }
    details[k] = v;
  }
  const cleanPhotos = Array.from(new Set(rawPhotos)).map((url) => {
    if (url.includes("drive.google.com")) {
      const fileId = url.match(/\/d\/(.+?)\//)?.[1] || url.match(/id=(.+?)(&|$)/)?.[1];
      return fileId ? `https://lh3.googleusercontent.com/d/${fileId}` : url;
    }
    return url;
  });
  const item = { id: hashId(`${brand}|${model}|${year}|${price}`), brand, model, year, price, photos: cleanPhotos, details };
  item.searchableText = buildSearchableText(item);
  return item;
}

async function loadInventory(client) {
  const t = Date.now();
  const cache = inventoryCaches[client.sheetUrl];
  if (cache?.rows?.length && t - cache.ts < INVENTORY_TTL_MS) return cache.rows;
  const res = await axios.get(client.sheetUrl, { timeout: 20000 });
  const lines = String(res.data || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const fieldKeys = detectFieldKeys(headers, client.fieldMapping);
  const rows = lines.slice(1).map(line => {
    const cols = parseCsvLine(line);
    const raw = {};
    headers.forEach((h, i) => (raw[h] = cols[i] || ""));
    return slimRow(raw, fieldKeys);
  });
  inventoryCaches[client.sheetUrl] = { ts: t, rows };
  return rows;
}

function isAskingForPhotos(text) {
  return ["foto", "fotos", "pictures", "pics", "images", "imagen"].some((h) => (text || "").toLowerCase().includes(h));
}

async function buildInventorySubset(chatId, inventory, userMessage) {
  const query = userMessage.toLowerCase();
  const wantsPhotos = isAskingForPhotos(userMessage);

  if (wantsPhotos) {
    const last = await getCandidates(chatId);
    if (last && last.length > 0) return last;
  }

  let matched = inventory.filter(item => {
    const brand = (item.brand || "").toLowerCase();
    const model = (item.model || "").toLowerCase();
    return (brand && query.includes(brand)) || (model && query.includes(model));
  });

  let finalSubset;
  if (matched.length > 0) {
    finalSubset = matched.slice(0, 15);
  } else {
    finalSubset = inventory.slice(0, 20);
  }
  await setCandidates(chatId, finalSubset.slice(0, 5));

  return finalSubset;
}

async function getLastMessages(chatId, limit = 12) {
  const { data } = await supabase.from("chat_messages").select("role,content").eq("chat_id", chatId).order("created_at", { ascending: false }).limit(limit);
  return (data || []).reverse();
}

async function addMessage(chatId, role, content) {
  await supabase.from("chat_messages").insert({ chat_id: chatId, role, content });
}

async function setCandidates(chatId, candidates) {
  await supabase.from("chat_sessions").update({ last_candidates: candidates }).eq("chat_id", chatId);
}

async function getCandidates(chatId) {
  const { data } = await supabase.from("chat_sessions").select("last_candidates").eq("chat_id", chatId).single();
  return data?.last_candidates || [];
}

function isWithinBusinessHours(hours) {
  if (!hours || !hours.start || !hours.end) return true;
  const now = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Guatemala"}));
  const time = now.getHours() * 100 + now.getMinutes();
  const start = parseInt(hours.start.replace(":", ""));
  const end = parseInt(hours.end.replace(":", ""));
  if (start < end) return time >= start && time <= end;
  return time >= start || time <= end;
}

function humanizeReply(text) {
  return (text || "").replace(/HOT_LEAD_DETECTED/g, "").trim();
}

app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;
    const chatId = data?.senderData?.chatId || data?.chatId;
    if (!chatId || !isAllowedChatId(chatId)) return res.sendStatus(200);

    const client = getClientByChatId(chatId);
    if (!client) return res.sendStatus(200);

    if (!isWithinBusinessHours(client.businessHours)) return res.sendStatus(200);
    
    if (data?.typeWebhook?.includes("outgoing") && data?.sendByApi === false) {
      const until = new Date(Date.now() + (client.takeoverHours || 3) * 3600000).toISOString();
      await supabase.from("chat_sessions").upsert({ chat_id: chatId, takeover_until: until }, { onConflict: 'chat_id' });
      return res.sendStatus(200);
    }

    if (data?.typeWebhook !== "incomingMessageReceived") return res.sendStatus(200);
    const userMessage = data?.messageData?.textMessageData?.textMessage;
    if (!userMessage) return res.sendStatus(200);

    const { data: session } = await supabase.from("chat_sessions").select("takeover_until").eq("chat_id", chatId).single();
    if (session?.takeover_until && new Date(session.takeover_until) > new Date()) return res.sendStatus(200);

    const memory = await getLastMessages(chatId, 12);
    const inventory = await loadInventory(client);
    const subset = await buildInventorySubset(chatId, inventory, userMessage);

    const aiResp = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      temperature: client.temperature ?? 0.4,
      messages: [{ role: "system", content: `${client.systemPrompt}\nInventory:\n${JSON.stringify(subset)}` }, ...memory, { role: "user", content: userMessage }]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });

        const rawReply = aiResp.data.choices[0].message.content;
    const isHotLead = rawReply.includes("HOT_LEAD_DETECTED");
    const reply = humanizeReply(rawReply); // כאן אנחנו מנקים את ה-Hot Lead

    if (isHotLead && client.agentPhone) {
      await axios.post(`https://api.greenapi.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`, { chatId: client.agentPhone, message: `🔥 Hot Lead: ${chatId}` });
    }

    if (rawReply.toUpperCase().includes("SEND_PHOTOS_NOW")) {
      const carId = rawReply.split(" ").find(p => p.startsWith("item_")) || subset[0]?.id;
      const item = inventory.find(c => c.id === carId);
      
      const cleanTextBeforePhotos = reply.replace(/SEND_PHOTOS_NOW\s+item_\w+/gi, "").trim();
      if (cleanTextBeforePhotos) {
        await axios.post(`https://api.greenapi.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`, { chatId, message: cleanTextBeforePhotos });
      }

      if (item?.photos) {
        for (const url of item.photos.slice(0, client.maxPhotos || 5)) {
          await axios.post(`https://api.greenapi.com/waInstance${GREEN_API_ID}/sendFileByUrl/${GREEN_API_TOKEN}`, { chatId, urlFile: url, fileName: "image.jpg" });
        }
      }
    } else {
      await axios.post(`https://api.greenapi.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`, { chatId, message: reply });
    }

    await addMessage(chatId, "user", userMessage);
    await addMessage(chatId, "assistant", reply);
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000);
