import "dotenv/config";

import { startHttpServer } from "./src/http.js";
import { createLogger } from "./src/logger.js";
import { createReputationStore } from "./src/reputation.js";
import { createBrain } from "./src/ai.js";
import { createMinecraftBot } from "./src/mc.js";

startHttpServer();

const logger = createLogger();
const reputation = createReputationStore();
const brain = createBrain({ logger });

createMinecraftBot({ logger, brain, reputation });

console.log(`[BOOT] logs -> ${logger.file}`);