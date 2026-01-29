import OpenAI from "openai";
import { z } from "zod";

/* =========================
   ZOD SCHEMAS (runtime)
========================= */

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
  args: z
    .object({
      message: z.string().optional(),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      range: z.number().optional()
    })
    .default({})
});

const PlanSchema = z.object({
  say: z.string().optional(),
  intent: z.string().optional(),
  mood: z.enum(["helper", "explorer", "fighter"]).optional(),
  actions: z.array(ActionSchema)
});

/* =========================
   BRAIN
========================= */

export function createBrain({ logger }) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  async function decide({
    kind,
    text,
    attackerName,
    worldState,
    recentChat,
    recentEvents,
    reputationSnapshot
  }) {
    const developerPrompt = `
Eres la IA que controla un bot en Minecraft Java usando Mineflayer.

REGLAS IMPORTANTES:
- Responde SOLO JSON válido
- Sigue EXACTAMENTE el schema
- No agregues texto fuera del JSON
- Si no sabes qué hacer, responde con una acción "chat"

Acciones permitidas:
- chat { message }
- stop {}
- follow_player { name, range }
- goto { x, y, z, range }
- attack_player { name }
- attack_nearest_mob { range }
- inventory_summary {}
- idle_roam {}

PvP:
- SOLO defensivo
- Si no te atacan, no ataques

Prioridad:
- Sobrevivir
- Ayudar
- Explorar
`.trim();

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
        { role: "developer", content: developerPrompt },
        { role: "user", content: JSON.stringify(payload) }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "minecraft_plan",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              say: { type: "string" },
              intent: { type: "string" },
              mood: {
                type: "string",
                enum: ["helper", "explorer", "fighter"]
              },
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
                        message: { type: "string" },
                        name: { type: "string" },
                        x: { type: "number" },
                        y: { type: "number" },
                        z: { type: "number" },
                        range: { type: "number" }
                      }
                    }
                  },
                  required: ["type", "args"]
                }
              }
            },
            required: ["actions"]
          }
        }
      }
    });

    const raw = resp.output_text;

    let json;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      logger.log({
        type: "ai_parse_error",
        raw
      });

      json = {
        actions: [
          {
            type: "chat",
            args: { message: "Me bugueé 😵‍💫, intenta de nuevo." }
          }
        ]
      };
    }

    const plan = PlanSchema.parse(json);

    logger.log({
      type: "ai_plan",
      kind,
      plan
    });

    return plan;
  }

  return { decide };
}