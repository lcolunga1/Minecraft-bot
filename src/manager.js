import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { logger } from "./utils_logger.js";
import { SharedMemory } from "./memory.js";
import { createToolset } from "./mc_tools.js";
import { startBrainLoop } from "./brain.js";

const { pathfinder, Movements } = pathfinderPkg;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function botName(prefix, slot) {
  return `${prefix}_${String(slot).padStart(2, "0")}`;
}

export class BotsManager {
  constructor() {
    this.shared = new SharedMemory();
    this.slots = new Map();
    this.stopping = false;

    this.count = parseInt(process.env.BOTS_COUNT || "1", 10);
    this.stagger = parseInt(process.env.STAGGER_JOIN_MS || "15000", 10);

    this.prefix = process.env.BOT_PREFIX || "deliriumai";

    // Credenciales (las pediste fijas)
    this.password = "deliriumai4928";
  }

  async start() {
    logger.info(`Iniciando ${this.count} bots en ${process.env.MC_HOST}:${process.env.MC_PORT} (SIN RECONEXIÓN)`);

    for (let slot = 1; slot <= this.count; slot++) {
      if (this.stopping) break;

      this.slots.set(slot, { bot: null, started: false });
      await this.spawnOnce(slot);

      // Evita que entren todos al mismo tiempo
      await sleep(this.stagger + jitter(0, 2000));
    }
  }

  async spawnOnce(slot) {
    if (this.stopping) return;

    const rec = this.slots.get(slot);
    if (!rec) return;
    if (rec.started) {
      logger.warn(`[Bot ${slot}] ya fue iniciado. No se vuelve a conectar.`);
      return;
    }
    rec.started = true;

    const username = botName(this.prefix, slot);
    logger.info(`[Bot ${slot}] conectando UNA SOLA VEZ como ${username}`);

    const bot = mineflayer.createBot({
      host: process.env.MC_HOST,
      port: Number(process.env.MC_PORT || 25565),
      username,
      auth: "offline"
      // No forzamos version; autodetect
    });

    rec.bot = bot;

    // ─────────────────────────────────────────────
    // Logs del motivo real (si lo hay)
    // ─────────────────────────────────────────────
    bot._client.on("login_error", (err) => {
      logger.error(`[Bot ${slot}] CLIENT login_error: ${err?.message || err}`);
    });

    bot._client.on("disconnect", (packet) => {
      try {
        logger.error(`[Bot ${slot}] CLIENT disconnect: ${JSON.stringify(packet)}`);
      } catch {
        logger.error(`[Bot ${slot}] CLIENT disconnect (no-json)`);
      }
    });

    bot._client.on("error", (err) => {
      logger.error(`[Bot ${slot}] CLIENT error: ${err?.message || err}`);
    });

    bot.on("kicked", (reason, loggedIn) => {
      logger.error(`[Bot ${slot}] KICKED loggedIn=${loggedIn} reason=${String(reason)}`);
    });

    bot.on("error", (e) => {
      logger.error(`[Bot ${slot}] ERROR: ${e?.message || e}`);
    });

    // ✅ Si termina, NO reconectar
    bot.on("end", () => {
      logger.warn(`[Bot ${slot}] END -> No reconecto (por configuración)`);
    });

    // ─────────────────────────────────────────────

    bot.loadPlugin(pathfinder);

    // Spawn timeout: si no spawnea, solo se queda “muerto” (sin reconectar)
    const spawnTimeout = setTimeout(() => {
      if (!bot.entity) {
        logger.error(`[Bot ${slot}] Spawn timeout (25s). No reconecto. Revisa server/puerto/config.`);
        try { bot.quit("spawn-timeout"); } catch {}
      }
    }, 25000).unref?.();

    bot.once("spawn", async () => {
      clearTimeout(spawnTimeout);
      logger.info(`[Bot ${slot}] SPAWN OK: ${username} (bot.version=${bot.version})`);

      // Movements best effort
      try {
        const mcData = await import("minecraft-data").then((m) => m.default(bot.version));
        bot.pathfinder.setMovements(new Movements(bot, mcData));
      } catch (e) {
        logger.warn(`[Bot ${slot}] Movements no cargados: ${e?.message || e}`);
      }

      // ✅ AUTH: register y login (como pediste)
      // Nota: /register puede fallar si ya está registrado, no pasa nada.
      try {
        await sleep(800);
        bot.chat(`/register ${this.password} ${this.password}`);
        logger.info(`[Bot ${slot}] enviado: /register ******`);

        await sleep(900);
        bot.chat(`/login ${this.password}`);
        logger.info(`[Bot ${slot}] enviado: /login ******`);

        // Reintento ligero del login por si el plugin tarda, SIN reconectar
        await sleep(2500);
        bot.chat(`/login ${this.password}`);
      } catch {}

      // Espera un poquito y arranca IA
      await sleep(2500);

      bot.sharedMemory = this.shared;
      bot.tools = createToolset(bot);
      startBrainLoop(bot, { slot });
    });
  }

  async shutdown() {
    this.stopping = true;

    for (const [slot, rec] of this.slots.entries()) {
      try {
        if (rec.bot) rec.bot.quit("shutdown");
      } catch {}
      this.slots.delete(slot);
    }

    this.shared.save();
  }
}