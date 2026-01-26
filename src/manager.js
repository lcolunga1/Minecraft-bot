import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { logger } from "./utils_logger.js";
import { SharedMemory } from "./memory.js";
import { createToolset } from "./mc_tools.js";
import { startBrainLoop } from "./brain.js";

const { pathfinder, Movements } = pathfinderPkg;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function genName(prefix) {
  const a = Math.floor(Math.random() * 9000 + 1000);
  const b = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}_${a}${b}`;
}

// ✅ Versión “estable” para Mineflayer (recomendado con ViaVersion en el server)
const FALLBACK_VERSION = "1.20.4";

export class BotsManager {
  constructor() {
    this.shared = new SharedMemory();
    this.bots = new Map();
    this.stopping = false;

    this.count = parseInt(process.env.BOTS_COUNT || "3", 10);
    this.stagger = parseInt(process.env.STAGGER_JOIN_MS || "12000", 10);

    this.reconnectBase = parseInt(process.env.RECONNECT_BASE_MS || "25000", 10);
    this.reconnectMax = parseInt(process.env.RECONNECT_MAX_MS || "180000", 10);
    this.reconnectJitter = parseInt(process.env.RECONNECT_JITTER_MS || "8000", 10);
    this.maxReconnects = parseInt(process.env.MAX_RECONNECTS || "999999", 10);

    // ✅ Fuerza una versión compatible con mineflayer
    // Pon en Render: MC_VERSION=1.20.4
    this.clientVersion = (process.env.MC_VERSION || FALLBACK_VERSION).trim();
  }

  async start() {
    logger.info(
      `Iniciando ${this.count} bots en ${process.env.MC_HOST}:${process.env.MC_PORT} (clientVersion=${this.clientVersion})`
    );

    for (let slot = 1; slot <= this.count; slot++) {
      if (this.stopping) break;
      await this.spawn(slot);
      await sleep(this.stagger + jitter(0, 1200));
    }
  }

  async spawn(slot, state = null) {
    const username = genName(process.env.BOT_PREFIX || "deliriumai");
    const st = state || { slot, reconnects: 0, nextDelay: this.reconnectBase };

    const bot = mineflayer.createBot({
      host: process.env.MC_HOST,
      port: Number(process.env.MC_PORT || 25565),
      username,
      // ✅ CLAVE: usar versión estable (1.20.4) en vez de 1.21.x
      version: this.clientVersion,
      auth: "offline"
    });

    bot.loadPlugin(pathfinder);

    bot.once("spawn", async () => {
      logger.info(`[Bot ${slot}] spawn OK: ${username} (v=${bot.version})`);

      // Movements (best effort)
      try {
        const mcData = await import("minecraft-data").then((m) => m.default(bot.version));
        bot.pathfinder.setMovements(new Movements(bot, mcData));
      } catch (e) {
        logger.warn(`[Bot ${slot}] No se pudo cargar movements: ${e?.message || e}`);
      }

      // XLogin
      await sleep(1200);
      const pass = process.env.BOT_PASSWORD || "deliriumai4928";
      const cmd = (process.env.LOGIN_COMMAND || "/login {password}").replace("{password}", pass);
      bot.chat(cmd);
      logger.info(`[Bot ${slot}] login enviado (/login ***)`);

      // Shared memory + toolset + brain
      bot.sharedMemory = this.shared;
      bot.tools = createToolset(bot);

      startBrainLoop(bot, { slot });
    });

    const onEnd = async (why) => {
      if (this.stopping) return;

      st.reconnects++;
      logger.warn(`[Bot ${slot}] desconectado (${username}): ${why}`);

      if (st.reconnects > this.maxReconnects) {
        logger.error(`[Bot ${slot}] max reconexiones alcanzado, deteniendo.`);
        return;
      }

      const delay = Math.min(st.nextDelay, this.reconnectMax) + jitter(0, this.reconnectJitter);
      st.nextDelay = Math.min(Math.floor(st.nextDelay * 1.6), this.reconnectMax);

      logger.warn(`[Bot ${slot}] reconectando en ${delay}ms...`);
      await sleep(delay);
      await this.spawn(slot, st);
    };

    bot.on("kicked", (r) => onEnd(`kicked: ${String(r)}`));
    bot.on("end", () => onEnd("end"));
    bot.on("error", (e) => logger.error(`[Bot ${slot}] error: ${e?.message || e}`));

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