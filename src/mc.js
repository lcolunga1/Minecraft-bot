import mineflayer from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";

const { pathfinder, Movements, goals } = pkg;

function distance(a, b) {
  if (!a || !b) return null;
  return a.distanceTo(b);
}

export function createMinecraftBot({ logger, brain, reputation }) {
  const bot = mineflayer.createBot({
    host: process.env.MC_HOST,
    port: Number(process.env.MC_PORT || 25565),
    username: process.env.MC_USER || "DeliriumAI_1",
    version: process.env.MC_VERSION || false
  });

  bot.loadPlugin(pathfinder);

  let mcMovements = null;
  let busy = false;

  const recentChat = [];
  const recentEvents = [];
  const pushLimited = (arr, item, limit = 30) => {
    arr.push(item);
    if (arr.length > limit) arr.shift();
  };

  function getWorldState() {
    const pos = bot.entity?.position;

    const playersNearby = Object.values(bot.players || {})
      .filter((p) => p?.entity)
      .map((p) => ({ name: p.username, dist: distance(p.entity.position, pos) }))
      .sort((a, b) => (a.dist ?? 9999) - (b.dist ?? 9999))
      .slice(0, 10);

    return {
      position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
      health: bot.health,
      food: bot.food,
      playersNearby
    };
  }

  function isInvocation(message) {
    const m = message.toLowerCase();
    return (
      m.startsWith("ai ") ||
      m.startsWith("delirium ") ||
      m.includes("@deliriumai") ||
      m.includes("trade") ||
      m.includes("cambio") ||
      m.includes("vendo") ||
      m.includes("compro") ||
      m.includes("ayuda") ||
      m.includes("help") ||
      m.includes("donde") ||
      m.includes("dónde") ||
      m.includes("como ") ||
      m.includes("cómo ")
    );
  }

  async function runAction(action) {
    const { type, args } = action ?? {};

    if (type === "chat") {
      bot.chat(String(args?.message ?? ""));
      return { ok: true };
    }

    if (type === "stop") {
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      return { ok: true };
    }

    if (type === "follow_player") {
      const name = String(args?.name ?? "");
      const p = bot.players?.[name]?.entity;
      if (!p) return { ok: false, error: "player_not_found" };
      bot.pathfinder.setGoal(new goals.GoalFollow(p, Number(args?.range ?? 2)), true);
      return { ok: true };
    }

    if (type === "goto") {
      const x = Math.floor(Number(args?.x));
      const y = Math.floor(Number(args?.y));
      const z = Math.floor(Number(args?.z));
      bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, Number(args?.range ?? 1)));
      return { ok: true };
    }

    if (type === "attack_player") {
      const name = String(args?.name ?? "");
      const target = bot.players?.[name]?.entity;
      if (!target) return { ok: false, error: "player_not_found" };
      bot.attack(target);
      return { ok: true, target: name };
    }

    if (type === "attack_nearest_mob") {
      const range = Number(args?.range ?? 4);
      const target = bot.nearestEntity(
        (e) => e.type === "mob" && e.position.distanceTo(bot.entity.position) <= range
      );
      if (!target) return { ok: false, error: "no_mob_target" };
      bot.attack(target);
      return { ok: true, target: target.name ?? target.type };
    }

    if (type === "inventory_summary") {
      const items = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));
      return { ok: true, items };
    }

    if (type === "idle_roam") {
      const pos = bot.entity.position;
      const dx = Math.floor(Math.random() * 12 - 6);
      const dz = Math.floor(Math.random() * 12 - 6);
      bot.pathfinder.setGoal(new goals.GoalNear(pos.x + dx, pos.y, pos.z + dz, 2));
      return { ok: true, roam: { dx, dz } };
    }

    return { ok: false, error: "unknown_action" };
  }

  // opcional: timeout para que no se quede ocupado si la IA se cuelga
  const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);

  async function decideAndAct({ kind, text, attackerName = null }) {
    if (busy) return;
    busy = true;

    const worldState = getWorldState();

    // log de entrada SIEMPRE (y a consola para Render)
    try {
      logger.log({ type: "ai_input", kind, attackerName, text, worldState });
    } catch {}
    console.log("[AI INPUT]", { kind, attackerName, text });

    try {
      const decidePromise = brain.decide({
        kind,
        text,
        attackerName,
        worldState,
        recentChat,
        recentEvents,
        reputationSnapshot: reputation.snapshot(20)
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`AI_TIMEOUT_${AI_TIMEOUT_MS}ms`)), AI_TIMEOUT_MS)
      );

      const plan = await Promise.race([decidePromise, timeoutPromise]);

      // log de plan (importante para ver si viene malformado)
      try {
        logger.log({ type: "ai_plan", kind, attackerName, plan });
      } catch {}
      console.log("[AI PLAN]", plan);

      if (plan?.say) {
        bot.chat(plan.say);
        logger.log({ type: "chat_out", message: plan.say, kind });
      }

      // evita crash si actions no existe o no es array
      const actions = Array.isArray(plan?.actions) ? plan.actions : [];

      const results = [];
      for (const action of actions) {
        const r = await runAction(action);
        results.push({ action, result: r });
      }

      logger.log({ type: "ai_results", kind, attackerName, results });
    } catch (err) {
      // 1) Render SIEMPRE lo muestra
      console.error("[AI ERROR decideAndAct]", err);

      // 2) Logger con stack real
      logger.log({
        type: "error",
        where: "decideAndAct",
        message: err?.message,
        stack: err?.stack,
        raw: String(err)
      });

      bot.chat("Me bugueé 😵‍💫. Revisa los logs (Render).");
    } finally {
      busy = false;
    }
  }

  bot.once("spawn", () => {
    mcMovements = new Movements(bot);
    bot.pathfinder.setMovements(mcMovements);

    if (process.env.MC_LOGIN_CMD) {
      setTimeout(() => bot.chat(process.env.MC_LOGIN_CMD), 1200);
    }

    bot.chat("Soy DeliriumAI 🤖⚔️🏗️ (helper + explorador, PvP defensivo).");
    logger.log({ type: "spawn", user: bot.username });
  });

  bot.on("chat", async (username, message) => {
    if (username === bot.username) return;

    pushLimited(recentChat, { from: username, message });
    logger.log({ type: "chat_in", from: username, message });

    const m = message.toLowerCase();

    if (
      m.includes("gracias") ||
      m.includes("ty") ||
      m.includes("thx") ||
      m.includes("pls") ||
      m.includes("porfa")
    ) {
      reputation.markFriendly(username, "chat amable");
    }
    if (
      m.includes("noob") ||
      m.includes("idiota") ||
      m.includes("pendejo") ||
      m.includes("ez") ||
      m.includes("trash")
    ) {
      reputation.markRude(username, "chat tóxico");
    }

    if (!isInvocation(message)) return;

    await decideAndAct({
      kind: "chat_request",
      text: `${username}: ${message}`,
      attackerName: null
    });
  });

  bot.on("entityHurt", async (entity) => {
    if (!bot.entity || entity.id !== bot.entity.id) return;

    const pos = bot.entity.position;
    const nearest = Object.values(bot.players || {})
      .filter((p) => p?.entity)
      .map((p) => ({ name: p.username, dist: p.entity.position.distanceTo(pos) }))
      .sort((a, b) => a.dist - b.dist)[0];

    const attackerName = nearest?.name || null;
    pushLimited(recentEvents, { type: "hurt", attackerName, health: bot.health, food: bot.food });
    logger.log({ type: "hurt", attackerName, health: bot.health, food: bot.food });

    if (attackerName) reputation.markAttack(attackerName);

    await decideAndAct({
      kind: "under_attack",
      text: "Me atacaron. Decide si huir, hablar, o defenderme.",
      attackerName
    });
  });

  bot.on("kicked", (reason) => logger.log({ type: "kicked", reason: String(reason) }));
  bot.on("error", (err) => {
    console.error("[BOT ERROR]", err);
    logger.log({ type: "bot_error", message: err?.message, stack: err?.stack, raw: String(err) });
  });

  return { bot, decideAndAct };
}