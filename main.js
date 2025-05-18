// bot.js
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");
const dns        = require("dns").promises;
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const proxyDir = path.join(__dirname, "../Proxys");
if (!fs.existsSync(proxyDir)) fs.mkdirSync(proxyDir);

const unknownFile        = path.join(proxyDir, "unknown.json");
const customMappingFile = path.join(proxyDir, "customMappings.json");

// JSON load/save helpers
function loadJSON(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  return {};
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// track known mappings
let mapping = loadJSON(customMappingFile);
if (Object.keys(mapping).length === 0) saveJSON(customMappingFile, mapping);

function getInitialCount(category) {
  const fp = path.join(proxyDir, `${category}.json`);
  if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf-8")).length;
  return 0;
}
function saveLinkToFile(category, url) {
  const fp = path.join(proxyDir, `${category}.json`);
  const set = fs.existsSync(fp)
    ? new Set(JSON.parse(fs.readFileSync(fp, "utf-8")))
    : new Set();
  if (!set.has(url)) {
    set.add(url);
    fs.writeFileSync(fp, JSON.stringify(Array.from(set), null, 2));
  }
}
function getMapping(ip) {
  return mapping[ip];
}

bot.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!scan")) return;
  const args = message.content.split(" ");
  const range = parseInt(args[1], 10) || 100;
  const msgs  = await message.channel.messages.fetch({ limit: range });

  const urls = new Set();
  const progressMessage = await message.channel.send("Scanning...");
  const urlRx = /\b(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/\S*)?/gi;

  // collect URLs from messages and .txt attachments
  for (const msg of msgs.values()) {
    const textLinks = msg.content.match(urlRx) || [];
    for (let link of textLinks) {
      if (!link.startsWith("http")) link = "https://" + link;
      link = link.replace(/(:\d+)(\/|$)/, "$2");
      urls.add(link);
    }
    for (const att of msg.attachments.values()) {
      if (att.name?.endsWith(".txt")) {
        try {
          const res = await fetch(att.url);
          const txt = await res.text();
          const tlinks = txt.match(urlRx) || [];
          for (let link of tlinks) {
            if (!link.startsWith("http")) link = "https://" + link;
            link = link.replace(/(:\d+)(\/|$)/, "$2")
                       .replace(/^https?:\/\//, "")
                       .split("/")[0];
            urls.add("https://" + link);
          }
        } catch {}
      }
    }
  }

  const total = urls.size;
  let done = 0;
  const categorized = {};
  const unknownLinks = {};
  const stats = {};

  for (const urlStr of urls) {
    const domain = urlStr.replace(/^https?:\/\//, "").split("/")[0];
    try {
      const { address: ip } = await dns.lookup(domain);
      const cat = getMapping(ip);
      if (cat) {
        categorized[cat] = categorized[cat] || [];
        categorized[cat].push(urlStr);
        const before = getInitialCount(cat);
        saveLinkToFile(cat, urlStr);
        const after = getInitialCount(cat);
        if (after > before) {
          stats[cat] = stats[cat] || { initial: before, added: 0 };
          stats[cat].added++;
        }
      } else {
        unknownLinks[ip] = unknownLinks[ip] || [];
        unknownLinks[ip].push(urlStr);
      }
    } catch {}
    done++;
    let txt = `Scanning... ${Math.floor((done/total)*100)}% (${done}/${total})\n`;
    for (const c in stats) {
      txt += `${c} (${stats[c].initial}) +${stats[c].added}\n`;
    }
    await progressMessage.edit(txt);
  }

  // save unknown links
  const storedUnknown = loadJSON(unknownFile);
  for (const ip in unknownLinks) {
    storedUnknown[ip] = Array.from(new Set([...(storedUnknown[ip]||[]), ...unknownLinks[ip]]));
  }
  saveJSON(unknownFile, storedUnknown);

  // build result text
  let resultText = "**Scanned Links**\n\n";
  for (const cat in categorized) {
    resultText += `**${cat}**\n${categorized[cat].join("\n")}\n\n`;
  }
  if (Object.keys(unknownLinks).length) {
    resultText += "**Unknown Links**\n";
    for (const [ip, links] of Object.entries(unknownLinks)) {
      resultText += `(${ip})\n${links.join("\n")}\n\n`;
    }
  }
  const resultFile = path.join(proxyDir, "scan_results.txt");
  fs.writeFileSync(resultFile, resultText);
  await message.channel.send({ files: [new AttachmentBuilder(resultFile)] });
  await progressMessage.edit("Scan complete!");
});

// List supported proxies
bot.on("messageCreate", (message) => {
  if (message.content === "!proxy") {
    const list = Array.from(new Set(Object.values(mapping))).join("\n");
    message.reply(`Supported Proxies:\n${list}`);
  }
});

// Updated !get handler supporting spaces in proxyType
bot.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!get")) return;

  const rest = message.content.slice(4).trim();
  if (!rest) return message.reply("Usage: `!get <proxyType> [count]`");

  const parts = rest.split(/\s+/);
  let count = 1;
  let proxyType = rest;
  const last = parseInt(parts[parts.length - 1], 10);
  if (!isNaN(last)) {
    count = last;
    proxyType = parts.slice(0, -1).join(" ");
  }

  const filePath = path.join(proxyDir, `${proxyType}.json`);
  if (!fs.existsSync(filePath)) {
    return message.reply(`No links found for proxy type: **${proxyType}**`);
  }

  const links = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (!links.length) {
    return message.reply(`No links stored under **${proxyType}**`);
  }

  const picked = [];
  for (let i = 0; i < count && links.length > 0; i++) {
    const idx = Math.floor(Math.random() * links.length);
    picked.push(links[idx]);
    links.splice(idx, 1);
  }

  const outFile = path.join(proxyDir, "get_links.txt");
  fs.writeFileSync(outFile, picked.join("\n"), "utf-8");
  await message.reply({ files: [new AttachmentBuilder(outFile)] });
});

// Track an IP to a name
bot.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!track")) return;
  const args = message.content.split(" ");
  if (args.length < 3) return message.reply("Usage: !track <ip> <name>");

  const ip = args[1];
  const name = args.slice(2).join(" ");
  mapping = loadJSON(customMappingFile);
  mapping[ip] = name;
  saveJSON(customMappingFile, mapping);

  const stored = loadJSON(unknownFile);
  const toMove = stored[ip] || [];
  toMove.forEach(link => saveLinkToFile(name, link));
  delete stored[ip];
  saveJSON(unknownFile, stored);

  message.reply(`Tracked IP ${ip} as "${name}". Moved ${toMove.length} link(s).`);
});

bot.on("messageCreate", (message) => {
  if (message.content === "!help") {
    message.reply(`
Commands:
!scan [number]           - Scan last [number] messages for links.
!proxy                   - List supported proxy types.
!get <type> [count]      - Get [count] random links (type may have spaces).
!track <ip> <name>       - Map an IP to <name> and move its links.
`);
  }
});
bot.on("guildCreate", guild => {
  console.log(
    `Joined a new guild: ${guild.name}  (id: ${guild.id}, members: ${guild.memberCount})`
  );
});
bot.login(process.env.TOKEN);

bot.once("ready", () => {
  console.log(`Logged in as ${bot.user.tag}`);
  console.log("Connected guilds:");
  bot.guilds.cache.forEach(g =>
    console.log(`• ${g.name}  (id: ${g.id})`)
  );
});