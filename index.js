import "dotenv/config";

import { startHttpServer } from "./http.js";
import { createLogger } from "./logger.js";
import { createReputationStore } from "./reputation.js";
import { createBrain } from "./ai.js";
import { createMinecraftBot } from "./mc.js";

startHttpServer();

const logger = createLogger();
const reputation = createReputationStore();
const brain = createBrain({ logger });

createMinecraftBot({ logger, brain, reputation });

console.log(`[BOOT] logs -> ${logger.file}`);