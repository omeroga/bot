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

// ----------------- Multi-client inventory cache (per sheetUrl) -----------------
const inventoryCaches = {};
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

    const cleanPhotos = Array.from(new Set(rawPhotos)).map((url) => {
    if (url.includes("drive.google.com")) {
      const fileId = url.match(/\/d\/(.+?)\//)?.[1] || url.match(/id=(.+?)(&|$)/)?.[1];
      // Fixed: Added the $ sign before the curly braces
      return fileId ? `https://lh3.googleusercontent.com/d/${fileId}` : url;
    }
    return url;
  });

  const car = {
    id: hashId(`${brand}|${model}|${year}|${price}`),
    brand,
    model,
    year,
    price,
    photos: cleanPhotos,
    details,
  };

  car.searchableText = buildSearchableText(car);
  return car;
}

async function loadInventoryBySheetUrl(sheetUrl) {
  const t = Date.now();
  const cache = inventoryCaches[sheetUrl];

  if (cache?.rows?.length && t - cache.ts < INVENTORY_TTL_MS) return cache.rows;

  const sheetRes = await axios.get(sheetUrl, { timeout: 20000 });
  const csv = String(sheetRes.data || "");

  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    inventoryCaches[sheetUrl] = { ts: t, rows: [] };
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

  inventoryCaches[sheetUrl] = { ts: t, rows };
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

  // Minimal: keep only generic words - no model names
  if (t.includes("pickup") || t.includes("pick up")) return "pickup";
  if (t.includes("suv") || t.includes("camioneta")) return "suv";
  if (t.includes("sedan") || t.includes("sedán")) return "sedan";
  if (t.includes("hatchback") || t.includes("hatch")) return "hatchback";

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

  return ranked;
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
  return (data || []).slice().reverse().map((m) => ({ role: m.role, content: m.content }));
}

async function addMessage(chatId, role, content) {
  const { error } = await supabase.from("chat_messages").insert({ chat_id: chatId, role, content });
  if (error) throw error;

  const { data: ids, error: e2 } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .range(12, 200);

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

  const ranked = pickCandidates(inventory, userMessage);
  const top = ranked.slice(0, 8);

  await setCandidates(chatId, top.slice(0, 3));
  return top;
}

// ----------------- OpenAI + GreenAPI -----------------
async function sendWhatsAppMessage(chatId, message) {
  try {
    const text = String(message || "").trim();

    // 1. קודם כל שולח את הודעת הטקסט (הסברים + לינקים)
    const textUrl = `https://api.greenapi.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`;
    await axios.post(textUrl, { chatId, message: text }, { timeout: 20000 });

    // 2. מוציא את הלינקים של התמונות ושולח אותן כקבצים ויזואליים
    const urls = text.match(/https?:\/\/\S+/gi) || [];
    const imageUrls = urls.filter((u) => 
      /lh3\.googleusercontent\.com|drive\.google\.com|jpg|jpeg|png/i.test(u)
    );

    if (imageUrls.length > 0) {
      for (const url of imageUrls.slice(0, 5)) {
        const fileUrl = `https://api.greenapi.com/waInstance${GREEN_API_ID}/sendFileByUrl/${GREEN_API_TOKEN}`;
        await axios.post(
          fileUrl,
          {
            chatId,
            urlFile: url,
            fileName: "car_photo.jpg"
          },
          { timeout: 20000 }
        );
      }
    }
  } catch (err) {
    console.error("❌ sendWhatsAppMessage error:", err.message);
  }
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

// ----------------- Webhook with Takeover Logic -----------------
app.post("/webhook", async (req, res) => {
  try {
    if (!OPENAI_API_KEY || !GREEN_API_ID || !GREEN_API_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error("❌ CRITICAL: Missing env vars.");
      return res.sendStatus(500);
    }

    const data = req.body;
    const chatId = data?.senderData?.chatId || data?.chatId;

        // 1. זהוי הודעה ידנית ממך (Human Takeover)
    if (data?.typeWebhook === "outgoingMessageReceived" || data?.typeWebhook === "outgoingAPIMessageReceived") {
      if (data?.sendByApi === false && chatId) {
        // שליפת נתוני הלקוח כדי לבדוק אם מוגדר לו זמן אישי
        const client = getClientByChatId(chatId);
        
        // כאן מתבצע ה-Fallback: 
        // אם מוגדר takeoverHours בקליינט - נשתמש בו. אם לא - נשתמש ב-3.
        const hours = client?.takeoverHours || 3; 
        
        const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
        
        await supabase
          .from("chat_sessions")
          .update({ takeover_until: until })
          .eq("chat_id", chatId);
          
        console.log(`👤 Human takeover activated for ${chatId} for ${hours} hours (until ${until})`);
      }
      return res.sendStatus(200);
    }

    // 2. טיפול בהודעה נכנסת מהלקוח
    if (data?.typeWebhook !== "incomingMessageReceived") return res.sendStatus(200);

    const userMessage = data?.messageData?.textMessageData?.textMessage;
    if (!chatId || !userMessage) return res.sendStatus(200);

    // התעלמות מקבוצות ומלקוחות לא מורשים
    if (String(chatId).endsWith("@g.us")) return res.sendStatus(200);
    if (!isAllowedChatId(chatId)) return res.sendStatus(200);

    // 3. בדיקה אם הבוט בהשתקה (Takeover פעיל)
    const { data: sessionData } = await supabase
      .from("chat_sessions")
      .select("takeover_until")
      .eq("chat_id", chatId)
      .single();

    if (sessionData?.takeover_until && new Date(sessionData.takeover_until) > new Date()) {
      console.log(`🤫 Bot is silenced for ${chatId} due to human takeover.`);
      return res.sendStatus(200);
    }

    const client = getClientByChatId(chatId);
    if (!client) return res.sendStatus(200);

    const msg = String(userMessage).trim();
    if (!msg) return res.sendStatus(200);

    const lang = detectLanguage(msg);
    await ensureSession(chatId, lang);

    const memory = await getLastMessages(chatId, 12);
    const inventory = await loadInventoryBySheetUrl(client.sheetUrl);
    const inventorySubset = await buildInventorySubset(chatId, inventory, msg);

    const system = `
${client.systemPrompt}

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

    const reply = String(aiResp?.data?.choices?.[0]?.message?.content || "").trim() ||
      "Con gusto, ¿qué tipo de carro buscás?";

    await sendWhatsAppMessage(chatId, reply);

    await addMessage(chatId, "user", msg);
    await addMessage(chatId, "assistant", reply);

    return res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook Error:", e.message);
    return res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));