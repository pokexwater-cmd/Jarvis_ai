const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const { OPENROUTER_API_KEY, SUPABASE_URL, SUPABASE_KEY } = process.env;
const MODEL = process.env.MODEL || "openai/gpt-4o-mini";
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

async function viaOpenRouter(messages) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages }),
  });
  const data = await r.json();
  if (!data.choices) throw new Error("openrouter: " + JSON.stringify(data));
  return data.choices[0].message.content;
}

async function viaGemini(messages) {
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents }),
    }
  );
  const data = await r.json();
  if (!data.candidates) throw new Error("gemini: " + JSON.stringify(data));
  return data.candidates[0].content.parts[0].text;
}

async function viaCohere(messages) {
  const r = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.COHERE_MODEL || "command-r-08-2024", messages }),
  });
  const data = await r.json();
  if (!data.message) throw new Error("cohere: " + JSON.stringify(data));
  return data.message.content[0].text;
}

// OpenRouter first, then Gemini, then Cohere (only if their keys exist)
async function ask(messages) {
  const chain = [];
  if (OPENROUTER_API_KEY) chain.push(viaOpenRouter);
  if (process.env.GEMINI_API_KEY) chain.push(viaGemini);
  if (process.env.COHERE_API_KEY) chain.push(viaCohere);
  let last;
  for (const fn of chain) {
    try { return await fn(messages); } catch (e) { last = e; console.error(e.message); }
  }
  throw last || new Error("no AI keys set");
}

app.post("/chat", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) return res.status(400).json({ error: "missing fields" });

    const { data: mem } = await db.from("memories").select("fact").eq("session_id", sessionId);
    const { data: hist } = await db
      .from("messages").select("role,content").eq("session_id", sessionId)
      .order("created_at", { ascending: false }).limit(20);

    const facts = (mem || []).map((m) => "- " + m.fact).join("\n") || "(none yet)";
    const system =
      "You are a friendly, natural-sounding assistant. Adapt your tone and style to the user. " +
      "Keep replies concise.\nWhat you know about this user:\n" + facts;

    const messages = [
      { role: "system", content: system },
      ...(hist || []).reverse(),
      { role: "user", content: message },
    ];
    const reply = await ask(messages);

    await db.from("messages").insert([
      { session_id: sessionId, role: "user", content: message },
      { session_id: sessionId, role: "assistant", content: reply },
    ]);
    res.json({ reply });

    // learn new facts in the background
    try {
      const out = await ask([
        {
          role: "system",
          content:
            "Extract lasting facts or preferences about the user from their message. " +
            "Return ONLY a JSON array of short strings. Return [] if none. " +
            "Never include passwords, keys, or ID numbers.",
        },
        { role: "user", content: message },
      ]);
      const arr = JSON.parse(out.replace(/```json|```/g, "").trim());
      const known = new Set((mem || []).map((m) => m.fact.toLowerCase()));
      const rows = arr
        .filter((f) => typeof f === "string" && !known.has(f.toLowerCase()))
        .map((fact) => ({ session_id: sessionId, fact }));
      if (rows.length) await db.from("memories").insert(rows);
    } catch (_) {}
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: "server error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Running on " + port));
