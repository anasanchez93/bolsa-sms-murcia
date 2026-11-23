// Importa los PDF diarios "Nombramientos SMS dd.mm.aaaa" que publica SATSE Región de Murcia
// (contratos asignados cada día con la menor puntuación por categoría, área, tipo y ámbito).
import { createClient } from "npm:@supabase/supabase-js@2";
import { getDocumentProxy } from "npm:unpdf@0.12.1";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const HOST = "https://murcia.satse.es";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; bolsa-sms-murcia/1.0)" };
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// CATEGORÍA  ÁREA(S)  TIPO  ÁMBITO  PUNTOS  INICIO  [FIN]  [SI|NO]  [OBSERVACIONES]
const ROW = /^([A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ.\/()\-, ]*?)\s+(\d{1,2}(?:\s*[,y]\s*\d{1,2})*)\s+([A-Z]{2,4})\s+([A-Z]{2,5})\s+(\d{1,3}(?:[.,]\d+)?)\s+(\d{2}\/\d{2}\/\d{4})(?:\s+(\d{2}\/\d{2}\/\d{4}))?(?:\s+(SI|NO|SÍ))?(?:\s+(.*))?$/;

const iso = (d?: string) => { if (!d) return ""; const [dd, mm, yy] = d.split(/[\/.\-]/); return `${yy.length === 2 ? "20" + yy : yy}-${mm}-${dd}`; };

async function pdfLines(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} al descargar`);
  const pdf = await getDocumentProxy(new Uint8Array(await r.arrayBuffer()));
  const lines: string[] = []; let items = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    // Pasa a coordenadas de pantalla (sirve también para páginas giradas)
    const [va, vb, vc, vd, ve, vf] = page.getViewport({ scale: 1 }).transform;
    items += tc.items.length;
    const rows: { y: number; it: { x: number; s: string }[] }[] = [];
    for (const it of tc.items as any[]) {
      const s = (it.str ?? "").trim(); if (!s) continue;
      const e = it.transform[4], f = it.transform[5];
      const x = va * e + vc * f + ve, y = -(vb * e + vd * f + vf);
      let row = rows.find((rw) => Math.abs(rw.y - y) < 3);
      if (!row) { row = { y, it: [] }; rows.push(row); }
      row.it.push({ x, s });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const rw of rows) lines.push(rw.it.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ").replace(/\s+/g, " ").trim());
  }
  return { lines, items, paginas: pdf.numPages };
}

function parse(lines: string[]) {
  const filas: any[] = []; let fecha = "";
  for (const l of lines) {
    const m0 = l.match(/ASIGNADOS EL D[IÍ]A\s+(\d{2}[.\/]\d{2}[.\/]\d{4})/i);
    if (m0 && !fecha) fecha = iso(m0[1]);
    const m = l.match(ROW); if (!m) continue;
    const cat = m[1].trim();
    if (/^(CATEGORIA|UGT|SERVICIO|NOMBRAMIENTOS)/.test(cat)) continue;
    filas.push({
      categoria: cat, areas: m[2].split(/\s*[,y]\s*/).map(Number), tipo: m[3], ambito: m[4],
      puntos: m[5].replace(",", "."), fecha_inicio: iso(m[6]), fecha_fin: iso(m[7]),
      discapacidad: m[8] ? m[8] !== "NO" : null, observaciones: (m[9] ?? "").trim(),
    });
  }
  return { fecha, filas };
}

async function enlacesMes(anio: number, mes: number) {
  const slugs = [`ultimos-contratos-sms-murcia-${MESES[mes]}-${anio}`, `ultimos-contratos-sms-${MESES[mes]}-${anio}`];
  for (const s of slugs) {
    const r = await fetch(`${HOST}/w/${s}`, { headers: UA });
    if (!r.ok) continue;
    const h = await r.text();
    const links = [...h.matchAll(/href="([^"]*Nombramientos[^"]*\.pdf[^"]*)"/gi)].map((x) => new URL(x[1].replace(/&amp;/g, "&"), HOST).toString().replace(/\?t=\d+$/, ""));
    if (links.length) return [...new Set(links)];
  }
  return [];
}
const fechaDeUrl = (u: string) => { const m = decodeURIComponent(u).match(/(\d{1,2})[.\-](\d{2})[.\-](\d{2,4})\.pdf/i); return m ? iso(`${m[1].padStart(2, "0")}.${m[2]}.${m[3]}`) : ""; };

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const { data: ok } = await sb.rpc("bolsa_sms_token_ok", { p_token: req.headers.get("x-cron-token") ?? "" });
  if (!ok) return new Response("no autorizado", { status: 401 });

  const debug = u.searchParams.get("debug");
  if (debug) {
    const { lines, items, paginas } = await pdfLines(debug);
    const p = parse(lines);
    return Response.json({ items, paginas, lineas: lines.slice(0, 25), fecha: p.fecha, filas: p.filas.length, categorias: [...new Set(p.filas.map((f) => f.categoria))] });
  }

  // Meses a revisar: por defecto el actual y el anterior; ?desde=2026-01 para cargar histórico
  const hoy = new Date();
  const desde = u.searchParams.get("desde");
  const meses: [number, number][] = [];
  let a = desde ? +desde.slice(0, 4) : hoy.getFullYear(), m = desde ? +desde.slice(5, 7) - 1 : hoy.getMonth() - 1;
  if (m < 0) { m = 11; a--; }
  while (a < hoy.getFullYear() || (a === hoy.getFullYear() && m <= hoy.getMonth())) { meses.push([a, m]); if (++m > 11) { m = 0; a++; } }
  const max = +(u.searchParams.get("max") ?? 12);

  const { data: hechos } = await sb.rpc("bolsa_sms_docs_ok");
  const set = new Set((hechos ?? []) as string[]);
  const pendientes: string[] = [];
  for (const [aa, mm] of meses) for (const l of await enlacesMes(aa, mm)) if (!set.has(l)) pendientes.push(l);
  const res: any[] = [];
  for (const url of pendientes.slice(0, max)) {
    try {
      const { fecha, filas } = parse((await pdfLines(url)).lines);
      const f = fecha || fechaDeUrl(url);
      const err = filas.length ? null : "sin filas reconocidas (¿PDF escaneado?)";
      const { data, error } = await sb.rpc("bolsa_sms_guardar_contratos", { p_url: url, p_fecha: f || null, p_filas: filas, p_error: err });
      res.push({ url: decodeURIComponent(url.split("/").slice(-2, -1)[0]), fecha: f, filas: data, error: error?.message ?? err });
    } catch (e) {
      await sb.rpc("bolsa_sms_guardar_contratos", { p_url: url, p_fecha: fechaDeUrl(url) || null, p_filas: [], p_error: String(e) });
      res.push({ url, error: String(e) });
    }
  }
  return Response.json({ meses: meses.length, pendientes: pendientes.length, procesados: res });
});
