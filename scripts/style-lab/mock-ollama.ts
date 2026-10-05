/**
 * A stand-in Ollama server for checking the plumbing without a model:
 * it answers /api/tags and streams a crude rewrite of the last user
 * message (long sentences split, a few words swapped). Scores against it
 * mean nothing; it only proves the lab and the app talk to Ollama's API.
 *
 *   npm run style:mock            # listens on 127.0.0.1:11434
 *   MOCK_PORT=11435 npm run style:mock
 */

import http from "node:http";

const port = Number(process.env.MOCK_PORT || 11434);
const swaps: [RegExp, string][] = [[/\butiliz(e|ing|ed)\b/gi, "us$1"], [/\bin order to\b/gi, "to"], [/\bapproximately\b/gi, "about"], [/;\s*however,?\s*/gi, ". But "], [/,\s*which\s+/gi, ". It "], [/\bessentially\b/gi, ""]];

function rewrite(text: string): string {
  let out = text;
  for (const [re, to] of swaps) out = out.replace(re, to);
  return out.replace(/\s+([.,])/g, "$1").replace(/ {2,}/g, " ").trim();
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "mock:latest" }, { name: "llama3.1:latest" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const { model, messages } = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
      const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const reply = rewrite(last);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const words = reply.split(/(\s+)/);
      let i = 0;
      const tick = () => {
        if (i < words.length) {
          res.write(JSON.stringify({ model, message: { role: "assistant", content: words[i++] }, done: false }) + "\n");
          setTimeout(tick, 8);
        } else {
          res.write(JSON.stringify({ model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: messages.join(" ").length / 4 | 0, eval_count: words.length }) + "\n");
          res.end();
        }
      };
      tick();
    });
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, "127.0.0.1", () => console.log(`Mock Ollama listening on http://127.0.0.1:${port}`));
