import OpenAI from "openai";
import { z } from "zod";

// Zod: aceptar null porque el schema va a requerir todas las keys
const ArgsSchema = z
  .object({
    message: z.string().nullable(),
    name: z.string().nullable(),
    x: z.number().nullable(),
    y: z.number().nullable(),
    z: z.number().nullable(),
    range: z.number().nullable()
  })
  .default({
    message: null,
    name: null,
    x: null,
    y: null,
    z: null,
    range: null
  });

const ActionSchema = z.object({
  type: z.enum([
    "chat",
    "stop",
    "follow_player",
    "goto",
    "attack_player",
    "attack_nearest_mob",
    "inventory_summary",
    "idle_roam"
  ]),
  args: ArgsSchema
});

const PlanSchema = z.object({
  say: z.string().nullable(),
  intent: z.string().nullable(),
  mood: z.enum(["helper", "explorer", "fighter"]).nullable(),
  actions: z.array(ActionSchema)
});

// Limpia nulls para que mc.js use args normales
function normalizePlan(plan) {
  const cleanArgs = (args) => {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (v !== null && v !== undefined) out[k] = v;
    }
    return out;
  };

  return {
    say: plan.say ?? undefined,
    intent: plan.intent ?? undefined,
    mood: plan.mood ?? undefined,
    actions: (plan.actions || []).map((a) => ({
      type: a.type,
      args: cleanArgs(a.args)
    }))
  };
}

export function createBrain({ logger }) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  async function decide({
    kind,
    text,
    attackerName,
    worldState,
    recentChat,
    recentEvents,
    reputationSnapshot
  }) {
    const developer = [
      "Eres la IA que controla un bot en un servidor Minecraft Java (Mineflayer).",
      "Reglas:",
      "- Responde SOLO JSON válido con el esquema.",
      "- No agregues texto fuera del JSON.",
      "- PvP SOLO defensivo.",
      "",
      "IMPORTANTE SOBRE args:",
      "- SIEMPRE incluye las llaves: message,name,x,y,z,range.",
      "- Si no aplican, ponlas en null."
    ].join("\n");

    const payload = {
      kind,
      text,
      attackerName: attackerName || null,
      worldState,
      recentChat,
      recentEvents,
      reputationSnapshot
    };

    const resp = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "developer", content: developer },
        { role: "user", content: JSON.stringify(payload) }
      ],
      text: {
        format: {
          name: "minecraft_plan",
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              say: { type: ["string", "null"] },
              intent: { type: ["string", "null"] },
              mood: { type: ["string", "null"], enum: ["helper", "explorer", "fighter", null] },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    type: {
                      type: "string",
                      enum: [
                        "chat",
                        "stop",
                        "follow_player",
                        "goto",
                        "attack_player",
                        "attack_nearest_mob",
                        "inventory_summary",
                        "idle_roam"
                      ]
                    },
                    args: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        message: { type: ["string", "null"] },
                        name: { type: ["string", "null"] },
                        x: { type: ["number", "null"] },
                        y: { type: ["number", "null"] },
                        z: { type: ["number", "null"] },
                        range: { type: ["number", "null"] }
                      },
                      // 🔥 OpenAI exige required con TODAS las keys en properties
                      required: ["message", "name", "x", "y", "z", "range"]
                    }
                  },
                  required: ["type", "args"]
                }
              }
            },
            // para evitar otro 400, también lo hacemos completo
            required: ["say", "intent", "mood", "actions"]
          }
        }
      }
    });

    // Preferir parsed si existe
    let json = resp.output_parsed;
    if (!json) {
      const raw = resp.output_text || "";
      json = JSON.parse(raw);
    }

    const parsed = PlanSchema.parse(json);
    const plan = normalizePlan(parsed);

    logger.log({ type: "ai_plan", kind, plan });
    return plan;
  }

  return { decide };
}