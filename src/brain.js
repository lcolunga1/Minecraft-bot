import OpenAI from "openai";
import { logger } from "./utils_logger.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

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
  players.sort((a, b) => a.dist - b.dist);

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
    time: Date.now(),
    sharedBases: (bot.sharedMemory?.get?.().bases || []).slice(-5)
  };
}

export function startBrainLoop(bot, { slot }) {
  const thinkEvery = Number(process.env.THINK_EVERY_MS || 1200);
  const chatEnabled = (process.env.CHAT_ENABLED || "true") === "true";
  const chatCooldown = Number(process.env.CHAT_COOLDOWN_MS || 7000);

  let lastChatAt = 0;
  let busy = false;

  setInterval(async () => {
    if (busy) return;
    if (!bot?.entity) return;
    if (!bot.tools) return;

    busy = true;

    try {
      const obs = buildObservation(bot);
      const inv = await bot.tools.inventory_summary?.();

      const system = `
Eres un jugador real en Minecraft.
Elige UNA acción por ciclo para: sobrevivir, progresar (madera/piedra/crafteo), convivir y PvP cuando convenga.
No spamees chat. Habla solo si aporta algo.

Devuelve SOLO JSON válido con esta forma:
{
  "action": "move_to|stop|attack_nearest_player|flee_from_nearest_player|equip_best_weapon|eat_if_needed|mine_nearby|craft_basic_start|mark_base_here|say",
  "args": { ... }
}

Reglas:
- Si food baja, usa eat_if_needed.
- Si jugador muy cerca y tienes vida/arma: equip_best_weapon + attack_nearest_player.
- Si estás débil: flee_from_nearest_player.
- Si no tienes recursos: mine_nearby (blockName: "oak_log" o "stone" o "cobblestone").
- Si tienes algo de madera: craft_basic_start.
- Para hablar usa "say" con texto corto.
`.trim();

      const user = `OBS:\n${JSON.stringify(obs)}\nINV:\n${JSON.stringify(inv || {})}`;

      const resp = await client.chat.completions.create({
        model: process.env.MODEL || "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        response_format: { type: "json_object" }
      });

      const text = resp.choices?.[0]?.message?.content || "";
      const plan = safeJsonParse(text);

      if (!plan?.action) return;

      // chat gating
      if (plan.action === "say") {
        if (!chatEnabled) return;
        const now = Date.now();
        if (now - lastChatAt < chatCooldown) return;
        lastChatAt = now;
      }

      const action = String(plan.action);
      const args = (plan.args && typeof plan.args === "object") ? plan.args : {};

      const fn = bot.tools[action];
      if (typeof fn !== "function") {
        logger.warn(`[Bot ${slot}] acción desconocida: ${action}`);
        return;
      }

      await fn(args);
      logger.info(`[Bot ${slot}] acción=${action}`);
    } catch (e) {
      logger.error(`[Bot ${slot}] brain error: ${e?.message || e}`);
    } finally {
      busy = false;
    }
  }, thinkEvery);
}