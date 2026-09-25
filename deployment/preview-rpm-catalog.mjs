import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const catalog = JSON.parse(await readFile(path.join(root, "features/avatar-creator/rpm-catalog.json"), "utf8"));
const imageDir = path.join(root, "output/rpm-catalog-20260925/thumbnails");
const receipts = JSON.parse(await readFile(path.join(imageDir, "render-receipts.json"), "utf8"));
if (catalog.entries.length !== 33 || receipts.length !== 33) throw Error("Expected exactly 33 originals");
const hashes = new Set();
for (const item of catalog.entries) {
  const receipt = receipts.find(r => path.basename(r.file, ".glb") === item.stem);
  if (!receipt) throw Error("Missing render: " + item.stem);
  const actual = createHash("sha256").update(await readFile(receipt.file)).digest("hex");
  if (receipt.sha256 !== actual || hashes.has(actual)) throw Error("Changed or duplicate source: " + item.stem);
  hashes.add(actual);
  await stat(path.join(imageDir, item.stem + ".png"));
}
const escape = s => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const cards = catalog.entries.map(item => '<article data-category="' + escape(item.category) + '"><div class="frame"><img loading="lazy" src="/' + item.stem + '.png" alt="' + escape(item.name) + '"></div><h2>' + escape(item.name) + '</h2><p>' + escape(item.category) + ' · ' + (item.existing_listing ? "Ya existe; se actualizará" : "Nuevo") + '</p></article>').join("");
const page = '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YenHubs · Avatares</title><style>*{box-sizing:border-box}body{margin:0;background:#080f1d;color:#edf4ff;font:15px system-ui;padding:28px}header{max-width:1200px;margin:auto}h1{font-size:28px;margin:0 0 10px}header p{color:#b6c6df}nav{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}button,input{padding:11px 15px;border:1px solid #405470;border-radius:12px;background:#14233c;color:white;font:inherit}button[aria-pressed=true]{background:#177ba1}input{width:100%;max-width:460px}main{max-width:1200px;margin:20px auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:24px 18px}.frame{aspect-ratio:9/16;border:1px solid #30435e;border-radius:16px;overflow:hidden;background:radial-gradient(ellipse at 50% 40%,#243a58,#101c30 75%)}img{display:block;width:100%;height:100%;object-fit:contain}h2{font-size:15px;line-height:1.35;margin:10px 0 5px;min-height:2.7em}article p{font-size:12px;color:#aabdce;margin:0}article[hidden]{display:none}</style><header><h1>33 avatares</h1><p>Vista previa local. Nombres descriptivos, encuadre completo y fuentes originales conservadas. Todavía no publicado.</p><input id="search" aria-label="Buscar avatares" placeholder="Buscar camisa, gafas, vestido…"><nav>' + ["Todos","Casual","Formal","Sanitario","Deportivo","Elegante"].map((c,i)=>'<button aria-pressed="'+(!i)+'">'+c+'</button>').join("") + '</nav></header><main>' + cards + '</main><script>let category="Todos";const search=document.querySelector("#search");function filter(){const q=search.value.toLocaleLowerCase("es");document.querySelectorAll("article").forEach(a=>a.hidden=!(category==="Todos"||a.dataset.category===category)||!a.innerText.toLocaleLowerCase("es").includes(q))}document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{category=b.textContent;document.querySelectorAll("nav button").forEach(x=>x.setAttribute("aria-pressed",x===b));filter()});search.oninput=filter;</script></html>';
const allowed = new Set(catalog.entries.map(x=>"/"+x.stem+".png"));
createServer(async (req,res)=>{
  const url = new URL(req.url, "http://127.0.0.1:8082");
  res.setHeader("Cache-Control","no-store");
  res.setHeader("Access-Control-Allow-Origin","http://localhost:8080");
  if(url.pathname==="/"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end(page);}
  else if(url.pathname==="/catalog.json"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify(catalog));}
  else if(allowed.has(url.pathname)){res.setHeader("Content-Type","image/png");res.end(await readFile(path.join(imageDir,path.basename(url.pathname))));}
  else {res.writeHead(404);res.end("Not found");}
}).listen(8082,"127.0.0.1",()=>console.log("Validated 33 unique sources; preview: http://127.0.0.1:8082"));
