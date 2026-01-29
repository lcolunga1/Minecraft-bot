const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function createReputationStore() {
  // score: -100 (muy agresivo) ... 0 (neutral) ... +100 (muy amistoso)
  const players = new Map();

  function ensure(name) {
    if (!players.has(name)) {
      players.set(name, {
        score: 0,
        lastSeen: Date.now(),
        lastAggro: 0,
        lastFriendly: 0,
        notes: []
      });
    }
    return players.get(name);
  }

  function decay(name) {
    const p = ensure(name);
    const now = Date.now();
    const dt = now - p.lastSeen;
    p.lastSeen = now;

    // Decaimiento suave hacia 0 (neutral) con el tiempo
    // cada ~10 min reduce ~10% del score
    const k = Math.pow(0.9, dt / (10 * 60 * 1000));
    p.score = Math.trunc(p.score * k);
  }

  function addNote(p, note) {
    p.notes.push({ t: Date.now(), note });
    if (p.notes.length > 20) p.notes.shift();
  }

  function markAttack(attackerName) {
    const p = ensure(attackerName);
    decay(attackerName);
    p.score = clamp(p.score - 35, -100, 100);
    p.lastAggro = Date.now();
    addNote(p, "me atacó");
  }

  function markFriendly(name, why = "amable") {
    const p = ensure(name);
    decay(name);
    p.score = clamp(p.score + 15, -100, 100);
    p.lastFriendly = Date.now();
    addNote(p, why);
  }

  function markRude(name, why = "tóxico") {
    const p = ensure(name);
    decay(name);
    p.score = clamp(p.score - 10, -100, 100);
    addNote(p, why);
  }

  function labelOf(name) {
    const p = ensure(name);
    decay(name);
    if (p.score <= -25) return "agresivo";
    if (p.score >= 25) return "amistoso";
    return "neutral";
  }

  function snapshot(limit = 20) {
    const arr = [];
    for (const [name, p] of players.entries()) {
      arr.push({ name, score: p.score, label: labelOf(name), lastAggro: p.lastAggro, lastFriendly: p.lastFriendly });
    }
    arr.sort((a, b) => a.score - b.score); // más agresivos primero
    return arr.slice(0, limit);
  }

  return { markAttack, markFriendly, markRude, labelOf, snapshot };
}