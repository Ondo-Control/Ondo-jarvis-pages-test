// Lädt die Geräte-Sonde nur auf ausdrückliche Anforderung (probe-request.json mit active:true und neuer Lauf-ID).
// Liest ausschließlich diese statische Datei; kein Mikrofon, keine Personendaten.
(function () {
  // Geräte-Sonde nur auf ausdrückliche Anforderung (probe-request.json mit active:true, neue Lauf-ID).
  fetch("../jarvis-probe/probe-request.json", {cache: "no-store"}).then((r) => r.ok ? r.json() : null).then((q) => {
    if (!q || q.active !== true || !/^[a-f0-9]{8,64}$/.test(q.run || "")) return;
    let done = ""; try { done = localStorage.getItem("probe_done") || ""; } catch (e) {}
    if (done === q.run) return;
    try { localStorage.setItem("probe_done", q.run); } catch (e) {}
    const url = "../jarvis-probe/index.html?env=" + (q.mode === "top" ? "top" : "skill") + "&run=" + q.run;
    if (q.mode === "top") {  // Messung ohne Iframe: Sondenseite ersetzt das Dokument (location.replace wird von der Hülle offenbar nicht ausgeführt)
      fetch(url.split("?")[0], {cache: "no-store"}).then((r) => r.text()).then((h) => {
        history.replaceState(null, "", "?" + url.split("?")[1]);
        document.open(); document.write(h); document.close();
      }).catch(() => {});
      return;
    }
    const f = document.createElement("iframe");
    f.allow = "microphone; camera; geolocation; autoplay; fullscreen";
    f.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;background:#06111f;z-index:9";
    f.src = url;
    document.body.appendChild(f);
  }).catch(() => {});
})();
