import { env } from "./env";

// One JSON-in/JSON-out call. Gemini first; if it's missing, fails, rate-limits or returns
// something that isn't valid JSON, the same prompt goes to OpenRouter.

export const aiReady = () => Boolean(env.geminiKey || env.openrouterKey);

type Ask = { system: string; prompt: string; temperature?: number };

function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(cleaned) as T;
}

async function gemini({ system, prompt, temperature = 0.6 }: Ask): Promise<string> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.geminiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: "application/json" },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = (await r.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${j.error?.message ?? "request failed"}`);
  const text = j.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini returned no text");
  return text;
}

async function openrouter({ system, prompt, temperature = 0.6 }: Ask): Promise<string> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.openrouterKey}`, "x-title": "Abro" },
    body: JSON.stringify({
      model: env.openrouterModel,
      temperature,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${j.error?.message ?? "request failed"}`);
  const text = j.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("OpenRouter returned no text");
  return text;
}

/** Check each configured provider with a tiny request. Used by Setup → Keys & services. */
export async function testAi() {
  const ask = { system: "Answer with JSON only.", prompt: 'Return {"ok": true}.', temperature: 0 };
  const out: { gemini: string; openrouter: string } = { gemini: "not set", openrouter: "not set" };
  if (env.geminiKey) out.gemini = await gemini(ask).then(t => (parseJson<{ ok?: boolean }>(t).ok ? `works (${env.geminiModel})` : "answered oddly")).catch(e => (e as Error).message.slice(0, 160));
  if (env.openrouterKey) out.openrouter = await openrouter(ask).then(t => (parseJson<{ ok?: boolean }>(t).ok ? `works (${env.openrouterModel})` : "answered oddly")).catch(e => (e as Error).message.slice(0, 160));
  return out;
}

/** Ask for JSON. Returns the parsed object and which provider answered. */
export async function askJson<T>(ask: Ask): Promise<{ data: T; via: "gemini" | "openrouter" }> {
  const errors: string[] = [];
  if (env.geminiKey) {
    try { return { data: parseJson<T>(await gemini(ask)), via: "gemini" }; }
    catch (e) { errors.push((e as Error).message); console.warn("Gemini failed, trying OpenRouter:", (e as Error).message); }
  }
  if (env.openrouterKey) {
    try { return { data: parseJson<T>(await openrouter(ask)), via: "openrouter" }; }
    catch (e) { errors.push((e as Error).message); }
  }
  throw new Error(errors.length ? errors.join(" | ") : "No AI key set (GEMINI_API_KEY or OPENROUTER_API_KEY).");
}
