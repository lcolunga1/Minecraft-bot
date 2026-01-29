import OpenAI from "openai";
import { z } from "zod";

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
  args: z.record(z.any()).default({})
});

const PlanSchema = z.object({
  say: z.string().optional(),
  intent: z.string().optional(),
  mood: z.enum(["helper", "explorer", "fighter"]).optional(),
  actions: z.array(ActionSchema).default([])
});

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
      "El servidor acepta Bedrock por Geyser/Floodgate, pero tú solo ves jugadores por nombre.",
      "",
      "Objetivo general del bot:",
      "- Ser un jugador más: explorar, construir, conseguir recursos.",
      "- Ser helper: responder dudas, apoyar en trade/ayuda.",
      "- PvP SOLO defensivo: si te agreden, puedes pelear o huir; si no te agreden, no inicies PvP.",
      "",
      "Clasificación por comportamiento:",
      "- Usa reputación (score/label) + chat + ataques recientes.",
      "- Si alguien te atacó recientemente => es agresivo.",
      "",
      "Reglas:",
      "- No grief, no robar, no destruir sin permiso.",
      "- Prioriza sobrevivir (vida/comida) antes de pelear.",
      "- Si falta info, pregunta en chat.",
      "",
      "Debes responder SOLO JSON válido con el esquema. No agregues texto fuera del JSON."
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
              say: { type: "string" },
              intent: { type: "string" },
              mood: { type: "string", enum: ["helper", "explorer", "fighter"] },
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
                    // ✅ FIX: args debe ser schema estricto
                    args: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        // chat
                        message: { type: "string" },

                        // follow/attack
                        name: { type: "string" },

                        // follow/goto/attack_nearest_mob
                        range: { type: "number" },

                        // goto
                        x: { type: "number" },
                        y: { type: "number" },
                        z: { type: "number" }
                      }
                      // no required aquí: depende del action.type
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

    // ✅ Mejor: si el SDK da output_parsed úsalo (evita JSON.parse)
    let json = resp.output_parsed;

    // fallback (por si tu versión del SDK no lo llena)
    if (!json) {
      const raw = resp.output_text || "";
      try {
        json = JSON.parse(raw);
      } catch {
        json = {
          say: "Tuve un error de formato. Repite.",
          actions: [{ type: "chat", args: { message: "Me bugueé 😵‍💫" } }]
        };
      }
    }

    const plan = PlanSchema.parse(json);
    logger.log({ type: "ai_plan", kind, payload, plan });
    return plan;
  }

  return { decide };
}