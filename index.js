const ALLOWED_CHAT_ID = "50231390807@c.us";
const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const GREEN_API_ID = (process.env.GREEN_API_ID || "").trim();
const GREEN_API_TOKEN = (process.env.GREEN_API_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1LUpyB8N-63EVOFCmzrolCm3mR0Mr6g8hAqtf7SfkUug/export?format=csv";

function assertEnv() {
  if (!GREEN_API_ID) console.error("❌ CRITICAL: GREEN_API_ID is missing");
  if (!GREEN_API_TOKEN) console.error("❌ CRITICAL: GREEN_API_TOKEN is missing");
  if (!OPENAI_API_KEY) console.error("❌ CRITICAL: OPENAI_API_KEY is missing");
  if (!SUPABASE_URL) console.error("❌ CRITICAL: SUPABASE_URL is missing");
  if (!SUPABASE_SERVICE_ROLE_KEY) console.error("❌ CRITICAL: SUPABASE_SERVICE_ROLE_KEY is missing");
}
assertEnv();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ----------------- Inventory cache -----------------
let inventoryCache = { ts: 0, rows: [] };
const INVENTORY_TTL_MS = 60 * 1000;

// ----------------- Robust CSV parse -----------------
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur.trim());
  return out;
}

function normalizeKey(k) {
  return String(k || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w\u00C0-\u024F\u0590-\u05FF_]/g, "");
}

function splitPhotoUrls(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(/[\s,|;\n\r]+/g)
    .map((p) => p.trim())
    .filter((p) => /^https?:\/\/\S+/i.test(p));
}

function safeString(v) {
  return String(v == null ? "" : v).trim();
}

function parseNumberLoose(v) {
  const s = safeString(v).replace(/[, ]/g, "");
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function headerScore(headerNorm, patterns) {
  let score = 0;
  for (const p of patterns) {
    if (headerNorm.includes(p)) score += 2;
    if (headerNorm === p) score += 3;
  }
  return score;
}

function detectFieldKeys(headers) {
  const canonPatterns = {
    model: ["modelo", "model", "vehiculo", "vehículo", "auto", "carro", "name", "nombre"],
    brand: ["marca", "brand", "make", "fabricante"],
    year: ["año", "ano", "year", "modelyear"],
    price: ["precio", "price", "q", "quetzal", "quetzales", "usd", "dolar", "dólar", "dolares", "dólares"],
    photos: ["fotos", "foto", "photos", "images", "imagenes", "imágenes", "galeria", "galería", "links", "url"],
  };

  const normMap = headers.map((h) => ({ orig: h, norm: normalizeKey(h) }));

  function pickBest(field) {
    let best = { orig: "", score: 0 };
    for (const h of normMap) {
      const s = headerScore(h.norm, canonPatterns[field]);
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
  return `car_${(h >>> 0).toString(16)}`;
}

function buildSearchableText(car) {
  const parts = [];
  parts.push(safeString(car.brand));
  parts.push(safeString(car.model));
  parts.push(safeString(car.year));
  parts.push(safeString(car.price));
  for (const k of Object.keys(car.details || {})) {
    parts.push(safeString(k));
    parts.push(safeString(car.details[k]));
  }
  return parts.join(" ").toLowerCase();
}

function slimCarRow(rawRow, fieldKeys) {
  const details = {};
  const rawPhotos = [];

  const model = safeString(rawRow[fieldKeys.modelKey] || "");
  const brand = safeString(rawRow[fieldKeys.brandKey] || "");
  const year = safeString(rawRow[fieldKeys.yearKey] || "");
  const price = safeString(rawRow[fieldKeys.priceKey] || "");

  if (fieldKeys.photosKey) rawPhotos.push(...splitPhotoUrls(rawRow[fieldKeys.photosKey]));

  for (const k of Object.keys(rawRow || {})) {
    const v = safeString(rawRow[k]);
    if (k === fieldKeys.modelKey || k === fieldKeys.brandKey || k === fieldKeys.yearKey || k === fieldKeys.priceKey || k === fieldKeys.photosKey) continue;
    const urls = splitPhotoUrls(v);
    if (urls.length) { rawPhotos.push(...urls); continue; }
    details[k] = v;
  }

  const cleanPhotos = Array.from(new Set(rawPhotos)).map(url => {
    if (url.includes('drive.google.com')) {
    const fileId = url.match(/\/d\/(.+?)\//)?.[1] || url.match(/id=(.+?)(&|$)/)?.[1];
    return fileId ? `https://lh3.googleusercontent.com/d/${fileId}` : url;
    }
    return url;
  });

  const car = {
    id: hashId(`${brand}|${model}|${year}|${price}`),
    brand, model, year, price,
    photos: cleanPhotos,
    details,
  };

  car.searchableText = buildSearchableText(car);
  return car;
}

async function loadInventory() {
  const t = Date.now();
  if (inventoryCache.rows.length && t - inventoryCache.ts < INVENTORY_TTL_MS) return inventoryCache.rows;

  const sheetRes = await axios.get(SHEET_URL, { timeout: 20000 });
  const csv = String(sheetRes.data || "");

  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    inventoryCache = { ts: t, rows: [] };
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  const fieldKeys = detectFieldKeys(headers);

  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const raw = {};
    headers.forEach((h, i) => (raw[h] = cols[i] || ""));
    rows.push(slimCarRow(raw, fieldKeys));
  }

  inventoryCache = { ts: t, rows };
  return rows;
}

// ----------------- Intent / matching -----------------
function isAskingForPhotos(text) {
  const t = (text || "").toLowerCase();
  return ["foto", "fotos", "pictures", "pics", "images", "imagen", "ver fotos", "mandame fotos", "mándame fotos"].some((h) => t.includes(h));
}

function extractBudget(text) {
  const t = (text || "").toLowerCase();
  const hasPriceContext = ["q", "quetzal", "quetzales", "usd", "$", "precio", "presupuesto", "budget", "hasta", "max", "máximo"].some((h) => t.includes(h));
  if (!hasPriceContext) return null;

  const nums = String(text).replace(/[,]/g, "").match(/\d{2,9}/g) || [];
  const values = nums.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (!values.length) return null;
  return Math.max(...values);
}

function detectType(text) {
  const t = (text || "").toLowerCase();
  const rules = [
    { type: "pickup", hints: ["pickup", "pick up", "hilux", "ranger", "tacoma", "frontier", "l200", "dmax", "d-max", "bt-50"] },
    { type: "suv", hints: ["suv", "camioneta", "4runner", "prado", "rav4", "cr-v", "crv", "cx-5", "x-trail", "xtrail", "tucson", "santa fe"] },
    { type: "sedan", hints: ["sedan", "sedán", "corolla", "civic", "sentra", "elantra", "accord", "camry"] },
    { type: "hatchback", hints: ["hatchback", "hatch", "yaris", "picanto", "rio hatch"] },
  ];
  for (const r of rules) if (r.hints.some((h) => t.includes(h))) return r.type;
  return null;
}

function extractKeywords(text) {
  const t = (text || "").toLowerCase();
  const kws = [];
  const list = [
    { k: "4x4", p: ["4x4", "4wd", "awd", "doble_traccion", "doble tracción", "traccion", "tracción"] },
    { k: "diesel", p: ["diesel", "diésel"] },
    { k: "gasoline", p: ["gasolina", "gasoline"] },
    { k: "automatic", p: ["automatico", "automático", "automatica", "automática"] },
    { k: "manual", p: ["manual", "mecánico", "mecanico"] },
    { k: "newer", p: ["reciente", "nuevo", "nuevito", "como nuevo"] },
  ];
  for (const item of list) if (item.p.some((x) => t.includes(x))) kws.push(item.k);
  return Array.from(new Set(kws));
}

function scoreCar(car, intent) {
  let score = 0;
  const text = car.searchableText || "";

  if (intent.type && text.includes(intent.type)) score += 6;

  for (const kw of intent.keywords) if (text.includes(kw)) score += 4;

  const yearNum = parseNumberLoose(car.year);
  if (intent.keywords.includes("newer") && yearNum) score += Math.min(10, Math.max(0, (yearNum - 2012) / 2));

  if (intent.budget) {
    const priceNum = parseNumberLoose(car.price);
    if (priceNum != null) {
      if (priceNum <= intent.budget) score += 12 - Math.min(12, (intent.budget - priceNum) / 5000);
      else score -= 6;
    }
  }

  if (car.photos && car.photos.length) score += 1;

  return score;
}

function pickCandidates(inventory, userMessage) {
  const intent = {
    budget: extractBudget(userMessage),
    type: detectType(userMessage),
    keywords: extractKeywords(userMessage),
  };

  const ranked = inventory
    .map((car) => ({ car, score: scoreCar(car, intent) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.car);

  return { intent, ranked };
}

// ----------------- Supabase memory functions -----------------
async function ensureSession(chatId, lang) {
  const payload = { chat_id: chatId, lang: lang || null, updated_at: new Date().toISOString() };
  const { error } = await supabase.from("chat_sessions").upsert(payload, { onConflict: "chat_id" });
  if (error) throw error;
}

async function getLastMessages(chatId, limit = 12) {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("role,content,created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  const msgs = (data || [])
    .slice()
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));
  return msgs;
}

async function addMessage(chatId, role, content) {
  const { error } = await supabase.from("chat_messages").insert({ chat_id: chatId, role, content });
  if (error) throw error;

  // Trim old messages to keep only last 12 (hard cap)
  const { data: ids, error: e2 } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .range(12, 200); // everything older than first 12

  if (e2) throw e2;
  if (ids && ids.length) {
    const toDelete = ids.map((x) => x.id);
    const { error: e3 } = await supabase.from("chat_messages").delete().in("id", toDelete);
    if (e3) throw e3;
  }
}

async function setCandidates(chatId, candidates) {
  const { error } = await supabase
    .from("chat_sessions")
    .update({ last_candidates: candidates || [], updated_at: new Date().toISOString() })
    .eq("chat_id", chatId);
  if (error) throw error;
}

async function getCandidates(chatId) {
  const { data, error } = await supabase.from("chat_sessions").select("last_candidates").eq("chat_id", chatId).single();
  if (error) return [];
  return Array.isArray(data?.last_candidates) ? data.last_candidates : [];
}

// ----------------- Subset builder -----------------
async function buildInventorySubset(chatId, inventory, userMessage) {
  const wantsPhotos = isAskingForPhotos(userMessage);

  if (wantsPhotos) {
    const last = await getCandidates(chatId);
    const lastWithPhotos = (last || []).filter((c) => c.photos && c.photos.length);
    if (lastWithPhotos.length) return lastWithPhotos.slice(0, 2);

    const withPhotos = inventory.filter((c) => c.photos && c.photos.length);
    return (withPhotos.length ? withPhotos : inventory).slice(0, 2);
  }

  const { ranked } = pickCandidates(inventory, userMessage);
  const top = ranked.slice(0, 8);

  // store top 3 for continuity
  await setCandidates(chatId, top.slice(0, 3));

  return top;
}

// ----------------- OpenAI + GreenAPI -----------------
async function sendWhatsAppMessage(chatId, message) {
  const url = `https://api.greenapi.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`;
  await axios.post(url, { chatId, message }, { timeout: 20000 });
}

function detectLanguage(text) {
  const t = (text || "").toLowerCase();
  if (/[\u0590-\u05FF]/.test(t)) return "he";
  const spanishHints = ["hola", "precio", "fotos", "tenes", "tenés", "carro", "camioneta", "cuanto", "cuánto", "financ"];
  const englishHints = ["hi", "price", "photos", "available", "how much", "finance"];
  let s = 0, e = 0;
  for (const w of spanishHints) if (t.includes(w)) s++;
  for (const w of englishHints) if (t.includes(w)) e++;
  return e > s ? "en" : "es";
}

app.post("/webhook", async (req, res) => {
  try {
    if (!OPENAI_API_KEY || !GREEN_API_ID || !GREEN_API_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error("❌ CRITICAL: Missing env vars.");
      return res.sendStatus(500);
    }

    const data = req.body;
    if (data?.typeWebhook !== "incomingMessageReceived") return res.sendStatus(200);

    const chatId = data?.senderData?.chatId;
    const userMessage = data?.messageData?.textMessageData?.textMessage;

    if (!chatId || !userMessage) return res.sendStatus(200);

    // 🔒 לאפשר תגובה רק למספר שלך
    if (chatId !== "50231390807@c.us") {
    return res.sendStatus(200);
}
    // optional: ignore groups
    if (String(chatId).endsWith("@g.us")) return res.sendStatus(200);

    const msg = String(userMessage).trim();
    if (!msg) return res.sendStatus(200);

    const lang = detectLanguage(msg);

    await ensureSession(chatId, lang);

    const memory = await getLastMessages(chatId, 12);

    const inventory = await loadInventory();
    const inventorySubset = await buildInventorySubset(chatId, inventory, msg);

    const system = `
You are a real human car salesman in Guatemala.

You do NOT talk like a bot.
You do NOT sound excited or exaggerated.
You do NOT use many exclamation marks.
You do NOT repeat yourself.

Your tone:
- calm
- confident
- friendly
- short sentences
- like someone answering WhatsApp messages naturally

You speak Spanish from Guatemala, softly and naturally.
Use light local expressions only when they fit the moment:
"mira", "fijo", "con gusto", "te cuento", "dale".
Never overuse slang.

Conversation behavior:
- Always answer exactly what the client asked.
- Do not change the topic.
- Do not add extra information unless it helps the answer.
- If the question is yes/no, answer yes or no first.
- Then add one short sentence of context if needed.

You never write long messages.
2–4 short lines maximum.

If the client asks about a specific detail:
- answer only that detail using details{}.
- do not talk about other cars.

If the client asks what is available:
- mention at most 2–3 options.
- very short summary only.

If the client asks for photos:
- send only the photo URLs.
- no explanations before or after.

You are not trying to impress.
You are trying to sound normal and trustworthy.

After some conversation, you may suggest meeting or test drive naturally,
only if it makes sense in context.

Language handling:
- If the user writes in Hebrew, respond in Hebrew.
- If the user writes in English, respond in English.
- Otherwise respond in Spanish (Guatemala).

Inventory data is always correct.
Never invent information.
Only use what exists in the inventory.

Inventory available right now:
${JSON.stringify(inventorySubset)}
`.trim();

    const aiResp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [{ role: "system", content: system }, ...memory, { role: "user", content: msg }],
      },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        timeout: 30000,
      }
    );

    const reply =
      String(aiResp?.data?.choices?.[0]?.message?.content || "").trim() ||
      "Con gusto, ¿qué tipo de carro buscás y más o menos en qué presupuesto?";

    await sendWhatsAppMessage(chatId, reply);

    await addMessage(chatId, "user", msg);
    await addMessage(chatId, "assistant", reply);

    return res.sendStatus(200);
  } catch (e) {
    const status = e?.response?.status;
    const body = e?.response?.data;
    console.error("❌ Error:", status || e.message);
    if (body) console.error("❌ Error Body:", JSON.stringify(body));
    return res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));