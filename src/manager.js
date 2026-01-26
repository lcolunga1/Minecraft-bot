import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { logger } from "./utils_logger.js";
import { SharedMemory } from "./memory.js";
import { createToolset } from "./mc_tools.js";
import { startBrainLoop } from "./brain.js";

const { pathfinder, Movements } = pathfinderPkg; // ✅ CommonJS fix

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function genName(prefix) {
  const a = Math.floor(Math.random() * 9000 + 1000);
  const b = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}_${a}${b}`;
}

// ✅ Versión estable para bots (si tienes ViaVersion puedes usar 1.20.4)
const FALLBACK_VERSION = "1.21.1";

export class BotsManager {
  constructor() {
    this.shared = new SharedMemory();
    this.bots = new Map();
    this.stopping = false;

    this.count = parseInt(process.env.BOTS_COUNT || "3", 10);

    // 🔥 para XLogin / evitar flood, recomendado más alto
    this.stagger = parseInt(process.env.STAGGER_JOIN_MS || "20000", 10);

    this.reconnectBase = parseInt(process.env.RECONNECT_BASE_MS || "30000", 10);
    this.reconnectMax = parseInt(process.env.RECONNECT_MAX_MS || "180000", 10);
    this.reconnectJitter = parseInt(process.env.RECONNECT_JITTER_MS || "8000", 10);
    this.maxReconnects = parseInt(process.env.MAX_RECONNECTS || "999999", 10);

    this.clientVersion = (process.env.MC_VERSION || FALLBACK_VERSION).trim();

    // XLogin password
    this.password = (process.env.BOT_PASSWORD || "deliriumai4928").trim();
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
    const username = genName(process.env.BOT_PREFIX || "deliriumai");
    const st = state || { slot, reconnects: 0, nextDelay: this.reconnectBase };

    const bot = mineflayer.createBot({
      host: process.env.MC_HOST,
      port: Number(process.env.MC_PORT || 25565),
      username,
      version: this.clientVersion,
      auth: "offline"
    });

    bot.loadPlugin(pathfinder);

    // ✅ Estado para no spamear comandos
    bot.__auth = {
      didRegister: false,
      didLogin: false,
      lastAuthAttempt: 0
    };

    // ✅ Auto register/login para XLogin (detecta mensajes)
    const PASSWORD = this.password;

    const maybeAuth = (text) => {
      const now = Date.now();

      // anti-spam: no mandar auth muy seguido
      if (now - bot.__auth.lastAuthAttempt < 1500) return;

      const t = text.toLowerCase();

      // Detecta mensajes típicos de plugins de login
      const wantsRegister =
        t.includes("register") ||
        t.includes("registr") || // "regístrate", "registrarse"
        t.includes("registrate") ||
        t.includes("registro");

      const wantsLogin =
        t.includes("login") ||
        t.includes("inicia sesión") ||
        t.includes("iniciar sesion") ||
        t.includes("autentic");

      if (wantsRegister && !bot.__auth.didRegister) {
        bot.__auth.lastAuthAttempt = now;
        bot.chat(`/register ${PASSWORD} ${PASSWORD}`);
        bot.__auth.didRegister = true;
        logger.info(`[Bot ${slot}] ${username} -> enviando /register`);
        return;
      }

      if (wantsLogin && !bot.__auth.didLogin) {
        bot.__auth.lastAuthAttempt = now;
        bot.chat(`/login ${PASSWORD}`);
        bot.__auth.didLogin = true;
        logger.info(`[Bot ${slot}] ${username} -> enviando /login`);
        return;
      }
    };

    bot.on("message", (msg) => {
      try {
        const text = msg.toString();
        // solo intentamos auth en los primeros segundos tras spawn
        if (!bot.__spawnAt) return;
        if (Date.now() - bot.__spawnAt > 25000) return;
        maybeAuth(text);
      } catch {}
    });

    bot.once("spawn", async () => {
      bot.__spawnAt = Date.now();
      logger.info(`[Bot ${slot}] spawn OK: ${username} (v=${bot.version})`);

      // Movements (best effort)
      try {
        const mcData = await import("minecraft-data").then((m) => m.default(bot.version));
        bot.pathfinder.setMovements(new Movements(bot, mcData));
      } catch (e) {
        logger.warn(`[Bot ${slot}] No se pudo cargar movements: ${e?.message || e}`);
      }

      // ✅ Fallback: si el server no manda mensajes, igual intenta auth
      // (útil cuando el plugin no manda "register/login" en chat visible)
      await sleep(2000);
      if (!bot.__auth.didLogin && !bot.__auth.didRegister) {
        // Primero probamos login, si no está registrado el plugin responderá con register
        bot.chat(`/login ${PASSWORD}`);
        bot.__auth.didLogin = true;
        bot.__auth.lastAuthAttempt = Date.now();
        logger.info(`[Bot ${slot}] ${username} -> login fallback enviado`);
      }

      // Espera un poquito y luego ya arrancamos IA
      await sleep(2500);

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