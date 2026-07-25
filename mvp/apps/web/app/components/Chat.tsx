"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
export function Chat({ onTurn }: { onTurn: () => void }) {
  const [msgs, setMsgs] = useState<{ role: string; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  async function send() {
    if (!input.trim() || busy) return;
    const next = [...msgs, { role: "user", text: input }];
    setMsgs(next); setInput(""); setBusy(true); setProgress("thinking…");
    const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: next.map((m) => ({ role: m.role, content: m.text })) }) });

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "progress") setProgress(event.label);
        else if (event.type === "done") setMsgs([...next, { role: "assistant", text: event.text }]);
        else if (event.type === "error") setMsgs([...next, { role: "assistant", text: `error: ${event.message}` }]);
      }
    }
    setProgress(null); setBusy(false); onTurn();
  }
  return (
    <div className="flex h-full flex-col rounded-lg border bg-card p-3">
      <h3>Chat</h3>
      <div className="flex-1 overflow-auto flex flex-col gap-1.5">
        {msgs.map((m, i) => {
          const mine = m.role === "user";
          return (
            <div key={i} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className="max-w-[80%] rounded-lg border bg-card p-1.5">
                <b>{m.role}:</b>{" "}
                {mine ? <span>{m.text}</span> : (
                  <span className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown></span>
                )}
              </div>
            </div>
          );
        })}
        {busy && (
          <div className="flex justify-start">
            <div className="font-mono text-xs rounded-lg border bg-card p-1.5 text-muted-foreground">
              assistant: {progress ?? "thinking…"}
            </div>
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()} className="flex-1" disabled={busy}
          placeholder="e.g. average salary for a senior accountant over 5 years" />
        <button onClick={send} disabled={busy}>{busy ? "Sending…" : "Send"}</button>
      </div>
    </div>
  );
}
