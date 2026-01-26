import "dotenv/config";
import { logger } from "./utils_logger.js";
import { BotsManager } from "./manager.js";

const manager = new BotsManager();

process.on("SIGINT", async () => {
  logger.warn("SIGINT: cerrando bots...");
  await manager.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.warn("SIGTERM: cerrando bots...");
  await manager.shutdown();
  process.exit(0);
});

await manager.start();