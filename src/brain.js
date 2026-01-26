import OpenAI from "openai";
import { logger } from "./utils_logger.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildObservation(bot) {
  const me = bot.entity;
  const players = [];

  for (const name in bot.players) {
    const p = bot.players[name];
    if (!p?.entity) continue;
    if (p.entity.id === me.id) continue;
    players.push({
      name,
      dist: Number(me.position.distanceTo(p.entity.position).toFixed(2)),
      pos: {
        x: Number(p.entity.position.x.toFixed(1)),
        y: Number(p.entity.position.y.toFixed(1)),
        z: Number(p.entity.position.z.toFixed(1))
      }
    });
  }
  players.sort((a,b)=>a.dist-b.dist);

  return {
    self: {
      username: bot.username,
      health: bot.health,
      food: bot.food,
      pos: {
        x: Number(me.position.x.toFixed(1)),
        y: Number(me.position.y.toFixed(1)),
        z: Number(me.position.z.toFixed(1))
      }
    },
    nearbyPlayers: players.slice(0, 6),
    sharedMemoryHint: {
      bases: (bot.sharedMemory.get().bases || []).slice(-5)
    }
  };
}

function safeJson(x) {
  try { return typeof x === "string" ? JSON.parse(x) : (x ?? {}); }
  catch { return {}; }
}

export function startBrainLoop(bot, { slot }) {
  const thinkEvery = Number(process.env.THINK_EVERY_MS || 1200);
  const chatEnabled = (process.env.CHAT_ENABLED || "true") === "true";
  const chatCooldown = Number(process.env.CHAT_COOLDOWN_MS || 7000);
  let lastChatAt = 0;
  let busy = false;

  const tools = [
    // movement
    { type: "function", function: { name: "move_to", parameters: { type:"object", properties:{x:{type:"number"},y:{type:"number"},z:{type:"number"},range:{type:"number"}}, required:["x","y","z"] } } },
    { type: "function", function: { name: "stop", parameters: { type:"object", properties:{} } } },
    { type: "function", function: { name: "look_at", parameters: { type:"object", properties:{x:{type:"number"},y:{type:"number"},z:{type:"number"}}, required:["x","y","z"] } } },

    // combat/survival
    { type: "function", function: { name: "equip_best_weapon", parameters:{ type:"object", properties:{} } } },
    { type: "function", function: { name: "attack_nearest_player", parameters:{ type:"object", properties:{ maxDist:{type:"number"} } } } },
    { type: "function", function: { name: "flee_from_nearest_player", parameters:{ type:"object", properties:{ seconds:{type:"number"}, maxDist:{type:"number"} } } } },
    { type: "function", function: { name: "eat_if_needed", parameters:{ type:"object", properties:{} } } },

    // gather/craft/base
    { type: "function", function: { name: "mine_nearby", parameters:{ type:"object", properties:{ blockName:{type:"string"}, maxDistance:{type:"number"}, count:{type:"number"} }, required:["blockName"] } } },
    { type: "function", function: { name: "craft_basic_start", parameters:{ type:"object", properties:{} } } },
    { type: "function", function: { name: "mark_base_here", parameters:{ type:"object", properties:{ name:{type:"string"} } } } },

    // memory + inventory
    { type: "function", function: { name: "get_shared_memory", parameters:{ type:"object", properties:{} } } },
    { type: "function", function: { name: "patch_shared_memory", parameters:{ type:"object", properties:{ patch:{type:"object"} }, required:["patch"] } } },
    { type: "function", function: { name: "inventory_summary", parameters:{ type:"object", properties:{} } } },

    // chat
    { type: "function", function: { name: "say", parameters:{ type:"object", properties:{ text:{type:"string"} }, required:["text"] } } }
  ];

  setInterval(async () => {
    if (busy) return;
    if (!bot?.entity) return;
    busy = true;

    try {
      const obs = buildObservation(bot);

      const system = `
Eres un jugador real en Minecraft (servidor Delirium).
Tú decides TODO: explorar, recolectar, craftear, hacer base, PvP, huir, hablar.
Prioridades (ajústalas según el contexto):
1) No morir: come si hace falta, huye si estás en desventaja.
2) Progresar: consigue madera/piedra, arma herramientas, arma espada.
3) Interacción humana: habla solo cuando convenga (no spam).
4) PvP: si conviene (gear y vida ok), busca pelea; si no, evita.
Memoria compartida: úsala para recordar bases, objetivos y reputación.
Devuelve UNA acción por ciclo usando UNA herramienta.
`.trim();

      const inv = await bot.tools.inventory_summary();

      const input = [
        { role: "system", content: system },
        { role: "user", content: `OBS:\n${JSON.stringify(obs)}\nINV:\n${JSON.stringify(inv)}` }
      ];

      const resp = await client.responses.create({
        model: process.env.MODEL || "gpt-5",
        input,
        tools
      });

      const call = resp.output?.find(o => o.type === "function_call");
      if (!call) return;

      const name = call.name;
      const args = safeJson(call.arguments);

      // chat gating
      if (name === "say") {
        if (!chatEnabled) return;
        const now = Date.now();
        if (now - lastChatAt < chatCooldown) return;
        lastChatAt = now;
      }

      if (!bot.tools[name]) return;

      const out = await bot.tools[name](args);

      // Si la tool devuelve algo útil, lo guarda en memoria opcionalmente
      if (out && (name === "get_shared_memory" || name === "inventory_summary")) {
        bot.sharedMemory.patch({ world: { lastInfoBy: bot.username, lastInfo: out } });
      }

      logger.info(`[Bot ${slot}] tool=${name}`);
    } catch (e) {
      logger.error(`[Bot ${slot}] brain error: ${e?.message || e}`);
    } finally {
      busy = false;
    }
  }, thinkEvery);
}