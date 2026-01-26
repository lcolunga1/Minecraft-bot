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

    this.stopping = false;

    // slot -> { bot, connecting:boolean, reconnectTimer, state }
    this.slots = new Map();

    this.count = parseInt(process.env.BOTS_COUNT || "1", 10);
    this.stagger = parseInt(process.env.STAGGER_JOIN_MS || "20000", 10);

    this.reconnectBase = parseInt(process.env.RECONNECT_BASE_MS || "30000", 10);
    this.reconnectMax = parseInt(process.env.RECONNECT_MAX_MS || "180000", 10);
    this.reconnectJitter = parseInt(process.env.RECONNECT_JITTER_MS || "8000", 10);
    this.maxReconnects = parseInt(process.env.MAX_RECONNECTS || "999999", 10);

    // IMPORTANTE: 1.21.1 autodetect (no forzamos version)
    this.prefix = process.env.BOT_PREFIX || "deliriumai";
  }

  async start() {
    logger.info(`Iniciando ${this.count} bots en ${process.env.MC_HOST}:${process.env.MC_PORT}`);

    for (let slot = 1; slot <= this.count; slot++) {
      if (this.stopping) break;

      this.slots.set(slot, {
        bot: null,
        connecting: false,
        reconnectTimer: null,
        state: { slot, reconnects: 0, nextDelay: this.reconnectBase }
      });

      await this.connectSlot(slot);
      await sleep(this.stagger + jitter(0, 2000));
    }
  }

  async connectSlot(slot) {
    if (this.stopping) return;

    const rec = this.slots.get(slot);
    if (!rec) return;

    // ✅ Lock: evita doble conexión por slot
    if (rec.connecting) {
      logger.warn(`[Bot ${slot}] connectSlot ignorado: ya connecting=true`);
      return;
    }

    // ✅ Si ya hay bot vivo, no reconectar encima
    if (rec.bot && !rec.bot._ended) {
      logger.warn(`[Bot ${slot}] connectSlot ignorado: bot ya existe y no terminó`);
      return;
    }

    // Limpia timer pendiente
    if (rec.reconnectTimer) {
      clearTimeout(rec.reconnectTimer);
      rec.reconnectTimer = null;
    }

    rec.connecting = true;

    const username = botName(this.prefix, slot);
    const st = rec.state;

    logger.info(`[Bot ${slot}] conectando como ${username} (reconnects=${st.reconnects})`);

    const bot = mineflayer.createBot({
      host: process.env.MC_HOST,
      port: Number(process.env.MC_PORT || 25565),
      username,
      auth: "offline"
    });

    rec.bot = bot;
    bot._ended = false;

    // ─────────────────────────────────────────────
    // Diagnóstico (pero sin provocar reconexión doble)
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

    bot._client.on("end", () => {
      logger.error(`[Bot ${slot}] CLIENT end`);
    });

    bot.on("kicked", (reason, loggedIn) => {
      logger.error(`[Bot ${slot}] KICKED loggedIn=${loggedIn} reason=${String(reason)}`);
      // guardamos último motivo
      bot._lastKickReason = String(reason || "");
    });

    bot.on("error", (e) => {
      logger.error(`[Bot ${slot}] ERROR: ${e?.message || e}`);
    });

    // ─────────────────────────────────────────────

    bot.loadPlugin(pathfinder);

    // Spawn timeout (si no spawnea, cerramos limpio)
    const spawnTimeout = setTimeout(() => {
      if (!bot.entity && !bot._ended) {
        logger.error(`[Bot ${slot}] Spawn timeout. Quit para reconectar...`);
        try { bot.quit("spawn-timeout"); } catch {}
      }
    }, 25000).unref?.();

    bot.once("spawn", async () => {
      clearTimeout(spawnTimeout);
      logger.info(`[Bot ${slot}] SPAWN OK: ${username} (bot.version=${bot.version})`);

      // Movements
      try {
        const mcData = await import("minecraft-data").then((m) => m.default(bot.version));
        bot.pathfinder.setMovements(new Movements(bot, mcData));
      } catch (e) {
        logger.warn(`[Bot ${slot}] Movements no cargados: ${e?.message || e}`);
      }

      // Arrancar IA
      bot.sharedMemory = this.shared;
      bot.tools = createToolset(bot);
      startBrainLoop(bot, { slot });

      // ✅ ya conectó bien
      rec.connecting = false;
      // reset backoff cuando logró spawn
      st.nextDelay = this.reconnectBase;
    });

    // ✅ Maneja FIN solo una vez
    const handleEndOnce = async (why) => {
      if (bot._ended) return;
      bot._ended = true;
      rec.connecting = false;

      clearTimeout(spawnTimeout);

      st.reconnects++;
      if (st.reconnects > this.maxReconnects) {
        logger.error(`[Bot ${slot}] max reconexiones alcanzado. Deteniendo.`);
        return;
      }

      // Si fue “logged in from another location”, espera más (evita pisarse)
      const lastKick = (bot._lastKickReason || "").toLowerCase();
      const isLoggedElsewhere =
        lastKick.includes("another location") ||
        lastKick.includes("otra ubic") ||
        why.toLowerCase().includes("another location");

      let baseDelay = st.nextDelay;
      if (isLoggedElsewhere) baseDelay = Math.max(baseDelay, 60000); // 60s mínimo

      const delay = Math.min(baseDelay, this.reconnectMax) + jitter(0, this.reconnectJitter);

      // backoff progresivo
      st.nextDelay = Math.min(Math.floor(baseDelay * 1.6), this.reconnectMax);

      logger.warn(`[Bot ${slot}] END (${why}). Reconnect en ${delay}ms`);
      rec.reconnectTimer = setTimeout(() => this.connectSlot(slot), delay);
      rec.reconnectTimer.unref?.();
    };

    bot.once("end", () => handleEndOnce("end"));

    // Por si quit manual o kick
    bot.once("kicked", (r) => handleEndOnce(`kicked: ${String(r)}`));
  }

  async shutdown() {
    this.stopping = true;

    for (const [slot, rec] of this.slots.entries()) {
      try {
        if (rec.reconnectTimer) clearTimeout(rec.reconnectTimer);
        if (rec.bot && !rec.bot._ended) rec.bot.quit("shutdown");
      } catch {}
      this.slots.delete(slot);
    }

    this.shared.save();
  }
}