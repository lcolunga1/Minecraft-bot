import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { logger } from "./utils_logger.js";
import { SharedMemory } from "./memory.js";
import { createToolset } from "./mc_tools.js";
import { startBrainLoop } from "./brain.js";

const { pathfinder, Movements } = pathfinderPkg;

// Utils
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function botName(prefix, slot) {
  return `${prefix}_${String(slot).padStart(2, "0")}`;
}

export class BotsManager {
  constructor() {
    this.shared = new SharedMemory();
    this.bots = new Map();
    this.stopping = false;

    // 🔧 Recomendación para debug: 1 bot primero
    this.count = parseInt(process.env.BOTS_COUNT || "1", 10);

    // Evita spam de conexiones
    this.stagger = parseInt(process.env.STAGGER_JOIN_MS || "20000", 10);

    this.reconnectBase = parseInt(process.env.RECONNECT_BASE_MS || "30000", 10);
    this.reconnectMax = parseInt(process.env.RECONNECT_MAX_MS || "180000", 10);
    this.reconnectJitter = parseInt(process.env.RECONNECT_JITTER_MS || "8000", 10);
    this.maxReconnects = parseInt(process.env.MAX_RECONNECTS || "999999", 10);

    // 🔥 IMPORTANTE: NO forzar version (autodetect)
    // this.clientVersion = (process.env.MC_VERSION || "1.21.1").trim();
  }

  async start() {
    logger.info(`Iniciando ${this.count} bots en ${process.env.MC_HOST}:${process.env.MC_PORT}`);

    for (let slot = 1; slot <= this.count; slot++) {
      if (this.stopping) break;
      await this.spawn(slot);
      await sleep(this.stagger + jitter(0, 2000));
    }
  }

  async spawn(slot, state = null) {
    const username = botName(process.env.BOT_PREFIX || "deliriumai", slot);
    const st = state || { slot, reconnects: 0, nextDelay: this.reconnectBase };

    logger.info(`[Bot ${slot}] creando bot ${username}`);

    // ✅ NO PASAR "version" -> autodetect
    const bot = mineflayer.createBot({
      host: process.env.MC_HOST,
      port: Number(process.env.MC_PORT || 25565),
      username,
      auth: "offline"
      // version: this.clientVersion, // ❌ QUITADO
    });

    // ─────────────────────────────────────────────
    // 🔴 LOGS DEL CLIENTE (AQUÍ sale la razón real)
    // ─────────────────────────────────────────────
    bot._client.on("login_error", (err) => {
      logger.error(`[Bot ${slot}] CLIENT login_error: ${err?.message || err}`);
    });

    bot._client.on("disconnect", (packet) => {
      try {
        logger.error(`[Bot ${slot}] CLIENT disconnect packet: ${JSON.stringify(packet)}`);
      } catch {
        logger.error(`[Bot ${slot}] CLIENT disconnect packet (no-json)`);
      }
    });

    bot._client.on("error", (err) => {
      logger.error(`[Bot ${slot}] CLIENT error: ${err?.message || err}`);
    });

    bot._client.on("end", () => {
      logger.error(`[Bot ${slot}] CLIENT end`);
    });

    // mineflayer-level
    bot.on("kicked", (reason, loggedIn) => {
      logger.error(`[Bot ${slot}] KICKED loggedIn=${loggedIn} reason=${String(reason)}`);
    });

    bot.on("end", () => {
      logger.error(`[Bot ${slot}] END`);
    });

    bot.on("error", (e) => {
      logger.error(`[Bot ${slot}] ERROR: ${e?.message || e}`);
    });

    // ─────────────────────────────────────────────
    // ⚙️ HARDENING: timeout / keepalive
    // ─────────────────────────────────────────────
    // Si en 20s no spawnea, matamos y reconectamos
    const spawnTimeout = setTimeout(() => {
      if (!bot.entity) {
        logger.error(`[Bot ${slot}] Spawn timeout (20s). Forzando quit para reconectar...`);
        try { bot.quit("spawn-timeout"); } catch {}
      }
    }, 20000).unref?.();

    // ─────────────────────────────────────────────

    bot.loadPlugin(pathfinder);

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

      // Espera corta antes IA
      await sleep(2500);

      bot.sharedMemory = this.shared;
      bot.tools = createToolset(bot);
      startBrainLoop(bot, { slot });
    });

    const onEnd = async (why) => {
      if (this.stopping) return;

      st.reconnects++;
      logger.warn(`[Bot ${slot}] desconectado (${username}) motivo=${why}`);

      if (st.reconnects > this.maxReconnects) {
        logger.error(`[Bot ${slot}] máximo de reconexiones alcanzado`);
        return;
      }

      const delay =
        Math.min(st.nextDelay, this.reconnectMax) + jitter(0, this.reconnectJitter);

      st.nextDelay = Math.min(Math.floor(st.nextDelay * 1.6), this.reconnectMax);

      logger.warn(`[Bot ${slot}] reconectando en ${delay}ms`);
      await sleep(delay);
      await this.spawn(slot, st);
    };

    bot.on("end", () => onEnd("end"));
    bot.on("kicked", (r) => onEnd(`kicked: ${String(r)}`));
    bot.on("error", (e) => onEnd(`error: ${e?.message || e}`));

    this.bots.set(username, bot);
  }

  async shutdown() {
    this.stopping = true;
    for (const bot of this.bots.values()) {
      try { bot.quit("shutdown"); } catch {}
    }
    this.bots.clear();
    this.shared.save();
  }
}