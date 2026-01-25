require('dotenv').config();
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const bot = mineflayer.createBot({
  host: process.env.MC_HOST,
  port: parseInt(process.env.MC_PORT),
  username: process.env.MC_USER,
});

bot.loadPlugin(pathfinder);

let mcData;
let defaultMove;

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version);
  defaultMove = new Movements(bot, mcData);
  bot.pathfinder.setMovements(defaultMove);

  bot.chat('Ya entré 🫂');
  setTimeout(() => bot.chat(`/register ${process.env.XLOGIN_PASS} ${process.env.XLOGIN_PASS}`), 2000);
  setTimeout(() => bot.chat(`/login ${process.env.XLOGIN_PASS}`), 4000);
});

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  if (!message.toLowerCase().startsWith('bot ')) return;

  const prompt = message.slice(4);

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: `Responde corto y amigable dentro de Minecraft: ${prompt}`
  });

  bot.chat(response.output_text.slice(0, 100));
});

bot.on('kicked', console.log);
bot.on('error', console.log);
