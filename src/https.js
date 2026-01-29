import express from "express";

export function startHttpServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 10000);

  app.get("/", (_, res) => res.status(200).send("DeliriumAI OK"));
  app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[HTTP] listening on 0.0.0.0:${PORT}`);
  });
}