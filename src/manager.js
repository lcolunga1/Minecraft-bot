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

// 🔒 Nombres FIJOS por slot (evita problemas de auth / antibot)
function botName(prefix, slot) {
  return `${prefix}_${String(slot).padStart(2, "0")}`;
}

export class BotsManager {
  constructor() {
    this.shared = new SharedMemory();
    this.bots = new Map();
    this.stopping = false;

    this.count = parseInt(process.env.BOTS_COUNT || "1", 10);
    this.stagger = parseInt(process.env.STAGGER_JOIN_MS || "20000", 10);

    this.reconnectBase = parseInt(process.env.RECONNECT_BASE_MS || "30000", 10);
    this.reconnectMax = parseInt(process.env.RECONNECT_MAX_MS || "180000", 10);
    this.reconnectJitter = parseInt(process.env.RECONNECT_JITTER_MS || "8000", 10);
    this.maxReconnects = parseInt(process.env.MAX_RECONNECTS || "999999", 10);

    // ⚠️ OJO: usa EXACTAMENTE la versión que soporte tu server
    // Si tu server es 1.21.1 y acepta clientes directos, deja esto así.
    this.clientVersion = (process.env.MC_VERSION || "1.21.1").trim();
  }

  async start() {
    logger.info(
      `Iniciando ${this.count} bots en ${process.env.MC_HOST}:${process.env.MC_PORT} (clientVersion=${this.clientVersion})`
    );

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

    const bot = mineflayer.createBot({
      host: process.env.MC_HOST,
      port: Number(process.env.MC_PORT || 25565),
      username,
      version: this.clientVersion,
      auth: "offline"
    });

    // ─────────────────────────────────────────────
    // 🔴 LOGS CRÍTICOS (AQUÍ VERÁS EL MOTIVO REAL)
    // ─────────────────────────────────────────────

    bot._client.on("disconnect", (packet) => {
      try {
        logger.error(
          `[Bot ${slot}] CLIENT DISCONNECT PACKET: ${JSON.stringify(packet)}`
        );
      } catch {
        logger.error(`[Bot ${slot}] CLIENT DISCONNECT PACKET (no-json)`);
      }
    });

    bot.on("kicked", (reason, loggedIn) => {
      logger.error(
        `[Bot ${slot}] KICKED loggedIn=${loggedIn} reason=${String(reason)}`
      );
    });

    bot.on("end", () => {
      logger.error(`[Bot ${slot}] END`);
    });

    bot.on("error", (e) => {
      logger.error(`[Bot ${slot}] ERROR: ${e?.message || e}`);
    });

    // ─────────────────────────────────────────────

    bot.loadPlugin(pathfinder);

    bot.once("spawn", async () => {
      logger.info(`[Bot ${slot}] SPAWN OK: ${username} (v=${bot.version})`);

      // Movements
      try {
        const mcData = await import("minecraft-data").then((m) =>
          m.default(bot.version)
        );
        bot.pathfinder.setMovements(new Movements(bot, mcData));
      } catch (e) {
        logger.warn(
          `[Bot ${slot}] Movements no cargados: ${e?.message || e}`
        );
      }

      // Espera corta antes de IA
      await sleep(3000);

      bot.sharedMemory = this.shared;
      bot.tools = createToolset(bot);
      startBrainLoop(bot, { slot });
    });

    const onEnd = async (why) => {
      if (this.stopping) return;

      st.reconnects++;
      logger.warn(
        `[Bot ${slot}] desconectado (${username}) motivo=${why}`
      );

      if (st.reconnects > this.maxReconnects) {
        logger.error(`[Bot ${slot}] máximo de reconexiones alcanzado`);
        return;
      }

      const delay =
        Math.min(st.nextDelay, this.reconnectMax) +
        jitter(0, this.reconnectJitter);

      st.nextDelay = Math.min(
        Math.floor(st.nextDelay * 1.6),
        this.reconnectMax
      );

      logger.warn(`[Bot ${slot}] reconectando en ${delay}ms`);
      await sleep(delay);
      await this.spawn(slot, st);
    };

    bot.on("end", () => onEnd("end"));
    bot.on("kicked", (r) => onEnd(`kicked: ${String(r)}`));

    this.bots.set(username, bot);
  }

  async shutdown() {
    this.stopping = true;
    for (const bot of this.bots.values()) {
      try {
        bot.quit("shutdown");
      } catch {}
    }
    this.bots.clear();
    this.shared.save();
  }
}