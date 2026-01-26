import { goals } from "mineflayer-pathfinder";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function nearestPlayer(bot, maxDist = 6) {
  const me = bot.entity;
  let best = null, bestD = Infinity;

  for (const name in bot.players) {
    const p = bot.players[name];
    if (!p?.entity) continue;
    if (p.entity.id === me.id) continue;
    const d = me.position.distanceTo(p.entity.position);
    if (d <= maxDist && d < bestD) { best = p.entity; bestD = d; }
  }
  return best;
}

function countInv(bot, itemName) {
  const items = bot.inventory?.items?.() || [];
  return items.filter(i => i.name === itemName).reduce((a, i) => a + i.count, 0);
}

export function createToolset(bot) {
  return {
    // MOV
    async move_to({ x, y, z, range = 2 }) {
      bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
    },
    async stop() {
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
    },

    // LOOK / CHAT
    async look_at({ x, y, z }) {
      await bot.lookAt({ x, y, z }, true);
    },
    async say({ text }) {
      bot.chat(String(text).slice(0, Number(process.env.CHAT_MAX_CHARS || 120)));
    },

    // COMBAT (simple)
    async equip_best_weapon() {
      // el modelo no sabe slots; esto elige lo mejor disponible básico
      const items = bot.inventory.items();
      const priority = ["netherite_sword","diamond_sword","iron_sword","stone_sword","wooden_sword"];
      const found = priority.map(n => items.find(i => i.name === n)).find(Boolean);
      if (found) await bot.equip(found, "hand");
    },
    async attack_nearest_player({ maxDist = 5 }) {
      const t = nearestPlayer(bot, maxDist);
      if (!t) return;
      await bot.lookAt(t.position.offset(0, 1.2, 0), true);
      bot.attack(t);
    },
    async flee_from_nearest_player({ seconds = 3, maxDist = 6 }) {
      const t = nearestPlayer(bot, maxDist);
      if (!t) return;
      // correr en dirección opuesta (simple)
      const dx = bot.entity.position.x - t.position.x;
      const dz = bot.entity.position.z - t.position.z;
      const mag = Math.max(0.0001, Math.sqrt(dx*dx + dz*dz));
      const nx = bot.entity.position.x + (dx / mag) * 10;
      const nz = bot.entity.position.z + (dz / mag) * 10;
      bot.pathfinder.setGoal(new goals.GoalNear(nx, bot.entity.position.y, nz, 2));
      await sleep(seconds * 1000);
      bot.pathfinder.setGoal(null);
    },

    // SURVIVAL
    async eat_if_needed() {
      if ((bot.food ?? 20) > 16) return;
      const items = bot.inventory.items();
      const food = items.find(i => i.name.includes("bread")) ||
                   items.find(i => i.name.includes("cooked")) ||
                   items.find(i => i.name.includes("apple"));
      if (!food) return;
      await bot.equip(food, "hand");
      await bot.consume();
    },

    // GATHER (básico)
    async mine_nearby({ blockName, maxDistance = 16, count = 4 }) {
      const mcData = await import("minecraft-data").then(m => m.default(bot.version)).catch(() => null);
      if (!mcData) return;

      const id = mcData.blocksByName?.[blockName]?.id;
      if (!id) return;

      let mined = 0;
      while (mined < count) {
        const b = bot.findBlock({ matching: id, maxDistance });
        if (!b) break;

        await bot.pathfinder.goto(new goals.GoalNear(b.position.x, b.position.y, b.position.z, 2));
        await bot.dig(b);
        mined++;
        await sleep(200);
      }
    },

    // CRAFT (super básico: tablas -> palos -> mesa)
    async craft_basic_start() {
      const mcData = await import("minecraft-data").then(m => m.default(bot.version)).catch(() => null);
      if (!mcData) return;

      const haveLogs = bot.inventory.items().find(i => i.name.endsWith("_log") || i.name.endsWith("_stem"));
      if (!haveLogs) return;

      // 1) planks
      const plankRecipe = bot.recipesFor(mcData.itemsByName.oak_planks.id, null, 1, null)[0];
      if (plankRecipe) await bot.craft(plankRecipe, 1, null);

      // 2) sticks
      const stickRecipe = bot.recipesFor(mcData.itemsByName.stick.id, null, 1, null)[0];
      if (stickRecipe) await bot.craft(stickRecipe, 1, null);

      // 3) crafting table
      const ctRecipe = bot.recipesFor(mcData.itemsByName.crafting_table.id, null, 1, null)[0];
      if (ctRecipe) await bot.craft(ctRecipe, 1, null);
    },

    // BASE (simple “marca base” + coloca mesa + 4 paredes low-tech si hay bloques)
    async mark_base_here({ name = "base" }) {
      const p = bot.entity.position;
      bot.sharedMemory.pushBase({
        name,
        x: Math.floor(p.x),
        y: Math.floor(p.y),
        z: Math.floor(p.z),
        by: bot.username,
        at: new Date().toISOString()
      });
      bot.sharedMemory.patch({ world: { lastBase: name } });
    },

    async get_shared_memory() {
      return bot.sharedMemory.get();
    },
    async patch_shared_memory({ patch }) {
      return bot.sharedMemory.patch(patch || {});
    },

    // OBS helpers para el modelo (lo uso yo en brain, pero también puede pedirlo)
    async inventory_summary() {
      const items = bot.inventory.items();
      const top = {};
      for (const it of items) top[it.name] = (top[it.name] || 0) + it.count;
      return {
        health: bot.health,
        food: bot.food,
        items: top,
        wood: Object.keys(top).filter(k => k.endsWith("_log") || k.endsWith("_planks")),
        stone: top.cobblestone || 0,
        swords: ["wooden_sword","stone_sword","iron_sword","diamond_sword","netherite_sword"].filter(n => top[n])
      };
    }
  };
}