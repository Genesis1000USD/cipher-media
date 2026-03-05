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
    req.on("timeout", () => { req.destroy(); reject(new Error("Download timed out")); });
  });
}

// ─── SEND HELPERS ─────────────────────────────────────────────
async function sendMsg(text) {
  await bot.sendMessage(CHAT_ID, text, { parse_mode: "Markdown" });
}

async function sendTyping() {
  await bot.sendChatAction(CHAT_ID, "upload_photo");
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
// IMAGE STYLES LIBRARY
// ══════════════════════════════════════════════════════════════

const STYLES = {
  cipher_brand: {
    label: "🔮 CIPHER Brand Art",
    prompts: [
      "mysterious hooded oracle figure glowing golden eyes void background ancient crypto symbols floating",
      "dark cyberpunk prophet silhouette surrounded by blockchain data streams gold purple neon",
      "ethereal digital oracle hands outstretched blockchain networks glowing dark cosmic void",
      "cipher symbol glowing gold surrounded by market data streams dark mystical atmosphere",
      "lone figure standing before massive glowing blockchain network dark apocalyptic sky gold light",
    ]
  },
  crypto_market: {
    label: "📊 Crypto Market Visual",
    prompts: [
      "dark holographic Bitcoin price chart glowing gold candlesticks ascending black void",
      "cryptocurrency market visualization glowing data streams multiple coins dark neon atmosphere",
      "Bitcoin gold coin shattering upward explosion dark background digital art cinematic",
      "crypto trading terminal dark cyberpunk multiple screens glowing charts real time data",
      "blockchain network visualization glowing nodes connections deep space purple gold",
    ]
  },
  breaking_news: {
    label: "🚨 Breaking News Graphic",
    prompts: [
      "urgent breaking news dark background red gold warning signals crypto market explosion",
      "dramatic breaking alert graphic dark stormy atmosphere lightning glowing text market crash",
      "urgent signal flare dark background market alert dramatic cinematic atmosphere",
      "breaking market event shattered charts explosion dramatic dark red gold atmosphere",
      "crypto market emergency signal dark command center multiple screens alert red warning",
    ]
  },
  price_animation: {
    label: "📈 Price Movement Visual",
    prompts: [
      "Bitcoin price surging upward green explosion dark background cinematic dramatic",
      "cryptocurrency price chart violent upward movement breaking resistance golden light",
      "market structure breakout visualization glowing green ascending dark void background",
      "price discovery zone glowing chart dark background gold particles ascending",
      "crypto bull run visualization Bitcoin charging upward golden energy dark background",
    ]
  },
  motivation: {
    label: "💪 Motivational Quote Card",
    prompts: [
      "lone warrior standing at dawn dark mountains horizon golden light breaking through",
      "solitary figure meditating above city lights dark atmosphere inner strength gold aura",
      "dark dramatic sunrise lone trader silhouette charts and wealth ascending powerful",
      "warrior mindset dark armor glowing eyes battlefield market charts background cinematic",
      "phoenix rising from dark ashes golden light transformation powerful dramatic atmosphere",
    ]
  },
  war_geo: {
    label: "⚔️ War/Geopolitical Visual",
    prompts: [
      "dark geopolitical chess board world map shadows dramatic cinematic no people",
      "global conflict visualization dark world map glowing tension lines dramatic atmosphere",
      "dark earth from space with glowing conflict zones dramatic satellite view cinematic",
      "geopolitical tension visualization dark stormy globe capital flows military colors",
      "world power dynamics dark visualization chess pieces globe dramatic lighting",
    ]
  },
};

const BASE_NEGATIVE = "no text, no words, no letters, no numbers, no watermarks, no logos";
const BASE_STYLE = "dark aesthetic, gold #c9a84c and deep purple #7c3aed color palette, void black background, cinematic mysterious photorealistic 8k ultra detailed";

// ── Generate image prompt with Claude ────────────────────────
async function enhancePrompt(basePrompt, customContext = "") {
  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 150,
    system: "You write ultra-detailed image generation prompts. Dark, cinematic, photorealistic. Under 300 chars. Never include text/words in prompts.",
    messages: [{
      role: "user",
      content: `Enhance this image prompt for CIPHER brand: "${basePrompt}" ${customContext ? `Context: ${customContext}` : ""}. Make it more detailed and dramatic. Under 300 chars.`
    }]
  });
  return response.content[0].text.trim();
}

// ── Generate image from Pollinations ─────────────────────────
async function generateImage(styleKey, customContext = "") {
  const style = STYLES[styleKey];
  const randomPrompt = style.prompts[Math.floor(Math.random() * style.prompts.length)];

  // Enhance with Claude
  let finalPrompt;
  try {
    finalPrompt = await enhancePrompt(randomPrompt, customContext);
  } catch {
    finalPrompt = randomPrompt;
  }

  const fullPrompt = `${finalPrompt}, ${BASE_STYLE}, ${BASE_NEGATIVE}`;
  const encoded = encodeURIComponent(fullPrompt);
  const seed = Math.floor(Math.random() * 999999);

  // Try different sizes for variety
  const sizes = ["1280x720", "1024x1024", "1280x720"];
  const size = sizes[Math.floor(Math.random() * sizes.length)];
  const [w, h] = size.split("x");

  const url = `https://image.pollinations.ai/prompt/${encoded}?width=${w}&height=${h}&nologo=true&seed=${seed}&enhance=true`;

  log(`Fetching image from Pollinations: ${finalPrompt.substring(0, 60)}...`);
  const buffer = await downloadBuffer(url, 60000);
  log(`✅ Image downloaded (${buffer.length} bytes)`);
  return { buffer, prompt: finalPrompt };
}

// ── Generate video using Python + ffmpeg ──────────────────────
async function generateVideo(styleKey, customContext = "") {
  log(`🎬 Generating video for ${styleKey}...`);

  // Generate 2 images and animate between them
  const [img1, img2] = await Promise.all([
    generateImage(styleKey, customContext),
    generateImage(styleKey, customContext),
  ]);

  const tmp1 = `/tmp/cipher_f1_${Date.now()}.jpg`;
  const tmp2 = `/tmp/cipher_f2_${Date.now()}.jpg`;
  const tmpOut = `/tmp/cipher_vid_${Date.now()}.mp4`;

  fs.writeFileSync(tmp1, img1.buffer);
  fs.writeFileSync(tmp2, img2.buffer);

  // Create animated video with crossfade using ffmpeg
  const ffmpegCmd = `ffmpeg -y \
    -loop 1 -t 4 -i "${tmp1}" \
    -loop 1 -t 4 -i "${tmp2}" \
    -filter_complex "\
      [0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fade=t=out:st=3:d=1[v0];\
      [1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fade=t=in:st=0:d=1[v1];\
      [v0][v1]concat=n=2:v=1:a=0[outv]" \
    -map "[outv]" \
    -c:v libx264 -pix_fmt yuv420p -crf 23 -preset fast \
    -movflags +faststart \
    "${tmpOut}"`;

  execSync(ffmpegCmd, { timeout: 60000, stdio: "pipe" });

  const videoBuffer = fs.readFileSync(tmpOut);

  // Cleanup
  [tmp1, tmp2, tmpOut].forEach(f => { try { fs.unlinkSync(f); } catch {} });

  log(`✅ Video generated (${videoBuffer.length} bytes)`);
  return { buffer: videoBuffer, prompt: img1.prompt };
}

// ══════════════════════════════════════════════════════════════
// COMMAND HANDLERS
// ══════════════════════════════════════════════════════════════

async function handleGenerate(styleKey, type = "image", customContext = "") {
  const style = STYLES[styleKey];
  await sendMsg(`⟁ *Generating ${style.label}...*\n_This takes 20-40 seconds_`);
  await sendTyping();

  try {
    if (type === "video") {
      await bot.sendChatAction(CHAT_ID, "upload_video");
      const { buffer, prompt } = await generateVideo(styleKey, customContext);
      const caption = `🎬 *${style.label}*\n\n_⟁ CIPHER Media_`;
      await sendVideo(buffer, caption);
      log(`✅ Video sent for ${styleKey}`);
    } else {
      const { buffer, prompt } = await generateImage(styleKey, customContext);
      const caption = `🎨 *${style.label}*\n\n_⟁ CIPHER Media_`;
      await sendPhoto(buffer, caption);
      log(`✅ Image sent for ${styleKey}`);
    }
  } catch (err) {
    log(`❌ Generation failed: ${err.message}`);
    await sendMsg(`❌ Generation failed: ${err.message}\n\nTry again — Pollinations can sometimes be slow.`);
  }
}

// ── /start ────────────────────────────────────────────────────
bot.onText(/\/start/, async () => {
  await sendMsg(`⟁ *CIPHER MEDIA BOT*
_The oracle generates on command._

*📸 IMAGE COMMANDS:*
/cipher — CIPHER brand art
/crypto — Crypto market visual
/news — Breaking news graphic
/price — Price movement visual
/motivation — Motivational quote card
/war — War/geopolitical visual

*🎬 VIDEO COMMANDS:*
/vcypher — CIPHER brand video
/vcrypto — Crypto market video
/vnews — Breaking news video
/vprice — Price movement video
/vmotivation — Motivation video
/vwar — War/geopolitical video

*🎲 RANDOM:*
/random — Random image, random style
/vrandom — Random video, random style

*🎨 CUSTOM:*
/custom <description> — Generate custom image
/vcustom <description> — Generate custom video

_All images are free. Generated by Pollinations.AI._`);
});

// ── IMAGE COMMANDS ────────────────────────────────────────────
bot.onText(/\/cipher$/, () => handleGenerate("cipher_brand", "image"));
bot.onText(/\/crypto$/, () => handleGenerate("crypto_market", "image"));
bot.onText(/\/news$/, () => handleGenerate("breaking_news", "image"));
bot.onText(/\/price$/, () => handleGenerate("price_animation", "image"));
bot.onText(/\/motivation$/, () => handleGenerate("motivation", "image"));
bot.onText(/\/war$/, () => handleGenerate("war_geo", "image"));

// ── VIDEO COMMANDS ────────────────────────────────────────────
bot.onText(/\/vcypher$/, () => handleGenerate("cipher_brand", "video"));
bot.onText(/\/vcrypto$/, () => handleGenerate("crypto_market", "video"));
bot.onText(/\/vnews$/, () => handleGenerate("breaking_news", "video"));
bot.onText(/\/vprice$/, () => handleGenerate("price_animation", "video"));
bot.onText(/\/vmotivation$/, () => handleGenerate("motivation", "video"));
bot.onText(/\/vwar$/, () => handleGenerate("war_geo", "video"));

// ── RANDOM ────────────────────────────────────────────────────
bot.onText(/\/random$/, () => {
  const keys = Object.keys(STYLES);
  const random = keys[Math.floor(Math.random() * keys.length)];
  handleGenerate(random, "image");
});

bot.onText(/\/vrandom$/, () => {
  const keys = Object.keys(STYLES);
  const random = keys[Math.floor(Math.random() * keys.length)];
  handleGenerate(random, "video");
});

// ── CUSTOM IMAGE ──────────────────────────────────────────────
bot.onText(/\/custom (.+)/, async (msg, match) => {
  const description = match[1].trim();
  if (!description) { await sendMsg("Usage: /custom <your description>"); return; }

  await sendMsg(`⟁ *Generating custom image...*\n_"${description.substring(0, 60)}"_`);
  await sendTyping();

  try {
    const fullPrompt = `${description}, ${BASE_STYLE}, ${BASE_NEGATIVE}`;
    const encoded = encodeURIComponent(fullPrompt);
    const seed = Math.floor(Math.random() * 999999);
    const url = `https://image.pollinations.ai/prompt/${encoded}?width=1280&height=720&nologo=true&seed=${seed}&enhance=true`;
    const buffer = await downloadBuffer(url, 60000);
    await sendPhoto(buffer, `🎨 *Custom: ${description.substring(0, 50)}*\n\n_⟁ CIPHER Media_`);
  } catch (err) {
    await sendMsg(`❌ Failed: ${err.message}`);
  }
});

// ── CUSTOM VIDEO ──────────────────────────────────────────────
bot.onText(/\/vcustom (.+)/, async (msg, match) => {
  const description = match[1].trim();
  if (!description) { await sendMsg("Usage: /vcustom <your description>"); return; }

  await sendMsg(`⟁ *Generating custom video...*\n_"${description.substring(0, 60)}"_\n_Takes 60-90 seconds_`);

  try {
    // Generate 2 images with same theme
    const prompt = `${description}, ${BASE_STYLE}, ${BASE_NEGATIVE}`;
    const encoded = encodeURIComponent(prompt);

    const [img1Buf, img2Buf] = await Promise.all([
      downloadBuffer(`https://image.pollinations.ai/prompt/${encoded}?width=1280&height=720&nologo=true&seed=${Math.floor(Math.random()*999999)}&enhance=true`, 60000),
      downloadBuffer(`https://image.pollinations.ai/prompt/${encoded}?width=1280&height=720&nologo=true&seed=${Math.floor(Math.random()*999999)}&enhance=true`, 60000),
    ]);

    const tmp1 = `/tmp/cipher_c1_${Date.now()}.jpg`;
    const tmp2 = `/tmp/cipher_c2_${Date.now()}.jpg`;
    const tmpOut = `/tmp/cipher_cv_${Date.now()}.mp4`;

    fs.writeFileSync(tmp1, img1Buf);
    fs.writeFileSync(tmp2, img2Buf);

    execSync(`ffmpeg -y \
      -loop 1 -t 4 -i "${tmp1}" \
      -loop 1 -t 4 -i "${tmp2}" \
      -filter_complex "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fade=t=out:st=3:d=1[v0];[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fade=t=in:st=0:d=1[v1];[v0][v1]concat=n=2:v=1:a=0[outv]" \
      -map "[outv]" -c:v libx264 -pix_fmt yuv420p -crf 23 -preset fast -movflags +faststart "${tmpOut}"`,
      { timeout: 90000, stdio: "pipe" }
    );

    const videoBuffer = fs.readFileSync(tmpOut);
    [tmp1, tmp2, tmpOut].forEach(f => { try { fs.unlinkSync(f); } catch {} });

    await sendVideo(videoBuffer, `🎬 *Custom: ${description.substring(0, 50)}*\n\n_⟁ CIPHER Media_`);
  } catch (err) {
    await sendMsg(`❌ Failed: ${err.message}`);
  }
});

// ── BULK: Generate all 6 styles at once ──────────────────────
bot.onText(/\/all$/, async () => {
  await sendMsg("⟁ *Generating all 6 styles...*\n_This will take a few minutes_");
  const keys = Object.keys(STYLES);
  for (const key of keys) {
    await handleGenerate(key, "image");
    await new Promise(r => setTimeout(r, 3000));
  }
  await sendMsg("✅ *All 6 styles generated!*");
});

// ── STATUS ────────────────────────────────────────────────────
bot.onText(/\/status/, async () => {
  await sendMsg(`⟁ *CIPHER MEDIA BOT — STATUS*

✅ Bot: Online
🎨 Image engine: Pollinations.AI (free)
🎬 Video engine: FFmpeg + Pollinations
🤖 AI prompt enhancer: Claude

*Available styles:*
• CIPHER Brand Art
• Crypto Market Visual
• Breaking News Graphic
• Price Movement Visual
• Motivational Quote Card
• War/Geopolitical Visual

_All systems operational._`);
});

// ─── STARTUP ──────────────────────────────────────────────────
log("⟁ CIPHER Media Bot starting...");
bot.sendMessage(CHAT_ID, "⟁ *CIPHER MEDIA BOT ONLINE*\n\nSend /start to see all commands.", { parse_mode: "Markdown" }).catch(() => {});
log("✅ CIPHER Media Bot is live. Send /start to begin.");
setInterval(() => {}, 1 << 30);
