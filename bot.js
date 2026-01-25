require('dotenv').config();
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const HOST = process.env.MC_HOST;
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const USERNAME = process.env.MC_USER || 'DeliriumBot';
const PASS = process.env.XLOGIN_PASS || 'pass123';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

const MODE = (process.env.MODE || 'leader').toLowerCase(); // leader | general
const LEADER_NAMES = (process.env.LEADER_NAMES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const memory = new Map(); // user -> [{role, content}]
const lastTalk = new Map(); // user -> timestamp
const globalCooldownMs = 4500;
const perUserCooldownMs = 9000;

function isLeader(name) {
  return LEADER_NAMES.map(n => n.toLowerCase()).includes(name.toLowerCase());
}

function memPush(user, role, content) {
  const arr = memory.get(user) || [];
  arr.push({ role, content });
  while (arr.length > 14) arr.shift();
  memory.set(user, arr);
}

function canReplyTo(user) {
  const now = Date.now();
  const u = lastTalk.get(user) || 0;
  const g = lastTalk.get('__global__') || 0;

  // líderes tienen menos cooldown
  const uCd = isLeader(user) ? 3500 : perUserCooldownMs;

  if (now - u < uCd) return false;
  if (now - g < globalCooldownMs) return false;

  lastTalk.set(user, now);
  lastTalk.set('__global__', now);
  return true;
}

function getState() {
  const p = bot.entity?.position;
  return {
    bot: {
      hp: bot.health,
      food: bot.food,
      pos: p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null
    },
    playersNearby: Object.keys(bot.players || {}).slice(0, 15),
  };
}

async function aiThink(user, text, state) {
  const hist = memory.get(user) || [];
  const system = `
Eres un jugador dentro de un servidor Minecraft.
Hablas español, natural, 1-2 líneas máximo. Cero spam.
Si MODE=leader, prioriza a tu líder y acompáñalo.
Si MODE=general, socializa con todos y actúa como jugador más.
Puedes proponer acciones, pero no des instrucciones técnicas.
Sé amigable y con personalidad, pero sin toxicidad.
`.trim();

  const input = [
    { role: 'system', content: system + `\nMODE=${MODE}\nLEADERS=${LEADER_NAMES.join(', ') || '(none)'}` },
    ...hist,
    { role: 'user', content: `Estado: ${JSON.stringify(state)}\n\n${user}: ${text}` }
  ];

  const resp = await openai.responses.create({ model: MODEL, input });
  const out = (resp.output_text || '').trim();
  return out || '¿Qué hacemos?';
}

// --- BOT ---
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME });
bot.loadPlugin(pathfinder);

let mcData, movements;

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version);
  movements = new Movements(bot, mcData);
  bot.pathfinder.setMovements(movements);

  bot.chat('Ya ando por aquí.');

  // xLogin
  setTimeout(() => bot.chat(`/register ${PASS} ${PASS}`), 2000);
  setTimeout(() => bot.chat(`/login ${PASS}`), 4500);

  // Autopilot base
  setInterval(autopilotTick, 9000);
});

function followPlayer(name) {
  const target = bot.players[name]?.entity;
  if (!target) return false;
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  return true;
}

function wander() {
  const p = bot.entity.position;
  const rx = Math.floor(p.x + (Math.random() * 24 - 12));
  const rz = Math.floor(p.z + (Math.random() * 24 - 12));
  bot.pathfinder.setGoal(new goals.GoalNear(rx, p.y, rz, 1));
}

function pickLeaderOnline() {
  // Si hay líderes definidos, elige el primero que esté online
  for (const name of LEADER_NAMES) {
    if (bot.players[name]?.entity) return name;
  }
  return null;
}

let lastAutopilotAction = 0;
async function autopilotTick() {
  const now = Date.now();
  if (now - lastAutopilotAction < 8000) return;
  lastAutopilotAction = now;

  if (MODE === 'leader') {
    const leader = pickLeaderOnline();
    if (leader) {
      // acompaña al líder, sin hablar de más
      followPlayer(leader);
      return;
    }
    // si líder no está, se comporta “general” suave
    wander();
    return;
  }

  // general: explora suave, se acerca a gente si hay cerca
  const nearby = Object.keys(bot.players || {}).filter(n => bot.players[n]?.entity);
  if (nearby.length) {
    const pick = nearby[Math.floor(Math.random() * nearby.length)];
    followPlayer(pick);
  } else {
    wander();
  }
}

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;

  // En modo leader, si no es líder, responde menos
  if (MODE === 'leader' && !isLeader(username)) {
    // solo responde si lo saludan o pregunta directa (muy básico)
    const m = message.toLowerCase();
    if (!m.includes('bot') && !m.includes('delirium') && !m.includes('hola') && !m.includes('?')) return;
  }

  if (!canReplyTo(username)) return;

  const text = message.trim();
  memPush(username, 'user', text);

  try {
    const state = getState();
    const reply = await aiThink(username, text, state);

    // 1-2 líneas máximo
    const lines = reply.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 2);
    for (const line of lines) bot.chat(line.slice(0, 220));

    memPush(username, 'assistant', lines.join(' '));
  } catch (e) {
    console.log(e);
  }
});

bot.on('kicked', console.log);
bot.on('error', console.log);