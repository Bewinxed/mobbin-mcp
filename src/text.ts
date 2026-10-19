// Word handling shared by tag lookup and app-scoped ranking.

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const words = (s: string) => norm(s).split(" ").filter(Boolean);

// Crude suffix stemmer: "chatting" → "chat", "creates"/"creating"/"create" → "creat", "messages" → "messag".
export const stem = (w: string) =>
  w.length <= 3 ? w : w.replace(/(ings|ing|ions|ion|ed|es|s|e)$/, "").replace(/([b-df-hj-np-tv-z])\1$/, "$1");

export const quote = (s: string) => `"${s}"`;
