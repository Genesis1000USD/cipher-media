import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── VALIDATE ENV ─────────────────────────────────────────────
const required = ["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
for (const key of required) {
  if (!process.env[key]) { console.error(`❌ Missing: ${key}`); process.exit(1); }
}

const HF_TOKEN = process.env.HF_TOKEN || null;

// ─── CLIENTS ──────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  console.log(entry);
  try { fs.appendFileSync(path.join(__dirname, "media-bot.log"), entry + "\n"); } catch {}
}

// ─── DOWNLOAD HELPER ──────────────────────────────────────────
function downloadBuffer(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ─── SEND HELPERS ─────────────────────────────────────────────
async function sendMsg(text) {
  await bot.sendMessage(CHAT_ID, text, { parse_mode: "Markdown" });
}
async function sendPhoto(buffer, caption) {
  await bot.sendPhoto(CHAT_ID, buffer, { caption, parse_mode: "Markdown" });
}
async function sendVideo(buffer, caption) {
  try {
    await bot.sendVideo(CHAT_ID, buffer, { caption, parse_mode: "Markdown", supports_streaming: true });
  } catch {
    await bot.sendDocument(CHAT_ID, buffer, { caption, parse_mode: "Markdown" });
  }
}

// ══════════════════════════════════════════════════════════════
// IMAGE GENERATION — 3 PROVIDERS WITH AUTO FALLBACK
// ══════════════════════════════════════════════════════════════

// ── Provider 1: Hugging Face (best, needs free token) ─────────
async function generateViaHuggingFace(prompt) {
  if (!HF_TOKEN) throw new Error("No HF_TOKEN set");
  log("Trying Hugging Face FLUX.1-schnell...");

  const response = await fetch(
    "https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { num_inference_steps: 4, width: 1280, height: 720 }
      }),
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`HF API error ${response.status}: ${err.substring(0, 100)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 5000) throw new Error("HF returned empty image");
  log(`✅ HF image ready (${buffer.length} bytes)`);
  return buffer;
}

// ── Provider 2: Pollinations with different models ────────────
async function generateViaPollinations(prompt, model = "flux") {
  log(`Trying Pollinations (model: ${model})...`);
  const encoded = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 999999);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1280&height=720&nologo=true&seed=${seed}&model=${model}`;
  const buffer = await downloadBuffer(url, 50000);
  if (buffer.length < 5000) throw new Error("Pollinations returned empty image");
  log(`✅ Pollinations image ready (${buffer.length} bytes)`);
  return buffer;
}

// ── Provider 3: DeepAI (free, no key needed for basic) ────────
async function generateViaDeepAI(prompt) {
  log("Trying DeepAI...");
  const formData = new URLSearchParams();
  formData.append("text", prompt);

  const response = await fetch("https://api.deepai.org/api/text2img", {
    method: "POST",
    headers: {
      "api-key": process.env.DEEPAI_KEY || "quickstart-QUdJIGlzIGF3ZXNvbWU",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData.toString(),
    signal: AbortSignal.timeout(45000),
  });

  const data = await response.json();
  if (!data.output_url) throw new Error("DeepAI no output URL");

  const buffer = await downloadBuffer(data.output_url, 30000);
  if (buffer.length < 5000) throw new Error("DeepAI returned empty image");
  log(`✅ DeepAI image ready (${buffer.length} bytes)`);
  return buffer;
}

// ── Master generator with auto-fallback ───────────────────────
async function generateImage(prompt) {
  const providers = [
    { name: "Hugging Face", fn: () => generateViaHuggingFace(prompt) },
    { name: "Pollinations (flux)", fn: () => generateViaPollinations(prompt, "flux") },
    { name: "Pollinations (turbo)", fn: () => generateViaPollinations(prompt, "turbo") },
    { name: "DeepAI", fn: () => generateViaDeepAI(prompt) },
  ];

  for (const provider of providers) {
    try {
      log(`Attempting: ${provider.name}`);
      const buffer = await provider.fn();
      log(`✅ Success via ${provider.name}`);
      return buffer;
    } catch (err) {
      log(`⚠️ ${provider.name} failed: ${err.message}`);
    }
  }

  throw new Error("All image providers failed. Please try again in a few minutes.");
}

// ══════════════════════════════════════════════════════════════
// STYLE LIBRARY
// ══════════════════════════════════════════════════════════════

const BASE = "no text no words no letters no numbers no watermarks, dark aesthetic, gold #c9a84c and deep purple #7c3aed color palette, void black background, cinematic mysterious photorealistic 8k ultra detailed";

const STYLES = {
  cipher_brand: {
    label: "🔮 CIPHER Brand Art",
    prompts: [
      `mysterious hooded oracle figure glowing golden eyes cosmic void ancient crypto symbols floating dark atmosphere, ${BASE}`,
      `dark cyberpunk prophet silhouette surrounded by blockchain data streams gold purple neon void, ${BASE}`,
      `ethereal digital oracle hands outstretched blockchain networks glowing dark cosmic void dramatic, ${BASE}`,
      `lone figure standing before massive glowing blockchain network dark apocalyptic sky gold light, ${BASE}`,
    ]
  },
  crypto_market: {
    label: "📊 Crypto Market Visual",
    prompts: [
      `dark holographic Bitcoin price chart glowing gold candlesticks ascending black void cinematic, ${BASE}`,
      `cryptocurrency market visualization glowing data streams multiple coins dark neon atmosphere, ${BASE}`,
      `Bitcoin gold coin shattering upward explosion dark background digital art cinematic dramatic, ${BASE}`,
      `blockchain network deep space visualization glowing nodes connections purple gold, ${BASE}`,
    ]
  },
  breaking_news: {
    label: "🚨 Breaking News Graphic",
    prompts: [
      `urgent breaking alert dark stormy atmosphere lightning market crash signals dramatic cinematic, ${BASE}`,
      `dramatic breaking dark red gold warning signals crypto market explosion urgent, ${BASE}`,
      `crypto market emergency signal dark command center multiple screens alert red warning, ${BASE}`,
    ]
  },
  price_animation: {
    label: "📈 Price Movement Visual",
    prompts: [
      `Bitcoin price surging upward green explosion dark background cinematic dramatic gold energy, ${BASE}`,
      `cryptocurrency price chart violent upward movement breaking resistance golden light rays, ${BASE}`,
      `bull market visualization Bitcoin charging upward golden energy dark void dramatic, ${BASE}`,
    ]
  },
  motivation: {
    label: "💪 Motivational Quote Card",
    prompts: [
      `lone warrior standing at dawn dark mountains horizon golden light breaking through dramatic, ${BASE}`,
      `solitary figure meditating above city lights dark atmosphere inner strength gold aura cinematic, ${BASE}`,
      `phoenix rising from dark ashes golden light transformation powerful dramatic atmosphere, ${BASE}`,
      `warrior mindset dark armor glowing eyes battlefield market charts background cinematic epic, ${BASE}`,
    ]
  },
  war_geo: {
    label: "⚔️ War/Geopolitical Visual",
    prompts: [
      `dark geopolitical chess board world map shadows dramatic cinematic atmospheric no people, ${BASE}`,
      `global conflict visualization dark world map glowing tension lines dramatic atmosphere, ${BASE}`,
      `dark earth from space glowing conflict zones dramatic satellite view cinematic, ${BASE}`,
    ]
  },
};

// ── Enhance prompt with Claude ────────────────────────────────
async function enhancePrompt(basePrompt) {
  try {
    const res = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 120,
      system: "You write ultra-detailed image prompts. Dark, cinematic, photorealistic. Under 250 chars. No text/words in image.",
      messages: [{ role: "user", content: `Enhance for CIPHER dark crypto brand: "${basePrompt.substring(0, 150)}". More dramatic and detailed. Under 250 chars.` }]
    });
    return res.content[0].text.trim();
  } catch {
    return basePrompt;
  }
}

// ── Handle generate command ───────────────────────────────────
async function handleGenerate(styleKey, type = "image", customPrompt = null) {
  const style = STYLES[styleKey];
  const label = style ? style.label : "🎨 Custom";

  await sendMsg(`⟁ *Generating ${label}...*\n_Trying multiple providers if needed_`);

  try {
    let prompt;
    if (customPrompt) {
      prompt = `${customPrompt}, ${BASE}`;
    } else {
      const prompts = style.prompts;
      const base = prompts[Math.floor(Math.random() * prompts.length)];
      prompt = await enhancePrompt(base);
    }

    if (type === "video") {
      await bot.sendChatAction(CHAT_ID, "upload_video");
      log("Generating 2 images for video...");
      const [buf1, buf2] = await Promise.all([
        generateImage(prompt),
        generateImage(prompt),
      ]);

      const t1 = `/tmp/cf1_${Date.now()}.jpg`;
      const t2 = `/tmp/cf2_${Date.now()}.jpg`;
      const tv = `/tmp/cv_${Date.now()}.mp4`;

      fs.writeFileSync(t1, buf1);
      fs.writeFileSync(t2, buf2);

      execSync(`ffmpeg -y \
        -loop 1 -t 4 -i "${t1}" \
        -loop 1 -t 4 -i "${t2}" \
        -filter_complex "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fade=t=out:st=3:d=1[v0];[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fade=t=in:st=0:d=1[v1];[v0][v1]concat=n=2:v=1:a=0[outv]" \
        -map "[outv]" -c:v libx264 -pix_fmt yuv420p -crf 23 -preset fast -movflags +faststart "${tv}"`,
        { timeout: 90000, stdio: "pipe" }
      );

      const vidBuf = fs.readFileSync(tv);
      [t1, t2, tv].forEach(f => { try { fs.unlinkSync(f); } catch {} });

      await sendVideo(vidBuf, `🎬 *${label}*\n\n_⟁ CIPHER Media_`);
    } else {
      await bot.sendChatAction(CHAT_ID, "upload_photo");
      const buffer = await generateImage(prompt);
      await sendPhoto(buffer, `🎨 *${label}*\n\n_⟁ CIPHER Media_`);
    }

    log(`✅ ${type} sent for ${styleKey}`);
  } catch (err) {
    log(`❌ Failed: ${err.message}`);
    await sendMsg(`❌ *Generation failed*\n\n${err.message}\n\n_Try /status to check providers_`);
  }
}

// ══════════════════════════════════════════════════════════════
// COMMANDS
// ══════════════════════════════════════════════════════════════

bot.onText(/\/start/, () => sendMsg(`⟁ *CIPHER MEDIA BOT*
_The oracle generates on command._

*📸 IMAGE COMMANDS:*
/cipher — CIPHER brand art
/crypto — Crypto market visual
/news — Breaking news graphic
/price — Price movement visual
/motivation — Motivational quote card
/war — War/geopolitical visual
/random — Random style

*🎬 VIDEO COMMANDS:*
/vcypher /vcrypto /vnews
/vprice /vmotivation /vwar /vrandom

*🎨 CUSTOM:*
/custom <description>
/vcustom <description>

*🛠️ OTHER:*
/all — Generate all 6 styles
/status — Check provider status`));

// Image commands
bot.onText(/\/cipher$/, () => handleGenerate("cipher_brand", "image"));
bot.onText(/\/crypto$/, () => handleGenerate("crypto_market", "image"));
bot.onText(/\/news$/, () => handleGenerate("breaking_news", "image"));
bot.onText(/\/price$/, () => handleGenerate("price_animation", "image"));
bot.onText(/\/motivation$/, () => handleGenerate("motivation", "image"));
bot.onText(/\/war$/, () => handleGenerate("war_geo", "image"));
bot.onText(/\/random$/, () => {
  const key = Object.keys(STYLES)[Math.floor(Math.random() * Object.keys(STYLES).length)];
  handleGenerate(key, "image");
});

// Video commands
bot.onText(/\/vcypher$/, () => handleGenerate("cipher_brand", "video"));
bot.onText(/\/vcrypto$/, () => handleGenerate("crypto_market", "video"));
bot.onText(/\/vnews$/, () => handleGenerate("breaking_news", "video"));
bot.onText(/\/vprice$/, () => handleGenerate("price_animation", "video"));
bot.onText(/\/vmotivation$/, () => handleGenerate("motivation", "video"));
bot.onText(/\/vwar$/, () => handleGenerate("war_geo", "video"));
bot.onText(/\/vrandom$/, () => {
  const key = Object.keys(STYLES)[Math.floor(Math.random() * Object.keys(STYLES).length)];
  handleGenerate(key, "video");
});

// Custom
bot.onText(/\/custom (.+)/, (msg, match) => handleGenerate(null, "image", match[1].trim()));
bot.onText(/\/vcustom (.+)/, (msg, match) => handleGenerate(null, "video", match[1].trim()));

// All styles
bot.onText(/\/all$/, async () => {
  await sendMsg("⟁ *Generating all 6 styles...*");
  for (const key of Object.keys(STYLES)) {
    await handleGenerate(key, "image");
    await new Promise(r => setTimeout(r, 3000));
  }
  await sendMsg("✅ *All 6 styles done!*");
});

// Status - test all providers
bot.onText(/\/status/, async () => {
  await sendMsg("⟁ *Checking all image providers...*");
  const results = [];

  // Test HF
  if (HF_TOKEN) {
    try {
      await generateViaHuggingFace("test dark abstract");
      results.push("✅ Hugging Face — ONLINE");
    } catch (e) {
      results.push(`❌ Hugging Face — ${e.message.substring(0, 40)}`);
    }
  } else {
    results.push("⚠️ Hugging Face — No HF_TOKEN set");
  }

  // Test Pollinations
  try {
    await generateViaPollinations("test dark abstract", "flux");
    results.push("✅ Pollinations — ONLINE");
  } catch (e) {
    results.push(`❌ Pollinations — ${e.message.substring(0, 40)}`);
  }

  // Test DeepAI
  try {
    await generateViaDeepAI("test dark abstract");
    results.push("✅ DeepAI — ONLINE");
  } catch (e) {
    results.push(`❌ DeepAI — ${e.message.substring(0, 40)}`);
  }

  await sendMsg(`⟁ *PROVIDER STATUS*\n\n${results.join("\n")}\n\n_Bot uses first available provider_`);
});

// ─── STARTUP ──────────────────────────────────────────────────
log("⟁ CIPHER Media Bot starting...");
log(`HF_TOKEN: ${HF_TOKEN ? "✅ Set" : "⚠️ Not set (will use fallbacks)"}`);
bot.sendMessage(CHAT_ID, "⟁ *CIPHER MEDIA BOT ONLINE*\n\nSend /start to see all commands.\nSend /status to check which image providers are working.", { parse_mode: "Markdown" }).catch(() => {});
log("✅ Ready.");
setInterval(() => {}, 1 << 30);
