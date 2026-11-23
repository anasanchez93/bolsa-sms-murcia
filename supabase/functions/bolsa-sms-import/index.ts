// Importa los "Últimos llamamientos" públicos de la Bolsa de Trabajo del SMS (sms.carm.es)
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BASE = "https://sms.carm.es/sms/bolsa/view/info/";
const ELEGIR = BASE + "elegirBolsaUltimosLlamamientos.xhtml";
const LL = BASE + "ultimosLlamamientosBolsa.xhtml";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; bolsa-sms-murcia/1.0)" };
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

type Jar = Record<string, string>;
function cookiesOf(r: Response, jar: Jar) {
  for (const [k, v] of r.headers) if (k.toLowerCase() === "set-cookie") {
    const [kv] = v.split(";"); const i = kv.indexOf("="); jar[kv.slice(0, i)] = kv.slice(i + 1);
  }
}
const cookieHdr = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
const vsOf = (h: string) => h.match(/javax\.faces\.ViewState[^>]*value="([^"]+)"/)?.[1] ?? "";
const txt = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const iso = (d: string) => { const m = d.match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ""; };

async function ajax(url: string, jar: Jar, params: Record<string, string>) {
  const r = await fetch(url, {
    method: "POST", redirect: "manual", body: new URLSearchParams(params),
    headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "Faces-Request": "partial/ajax", "X-Requested-With": "XMLHttpRequest", Cookie: cookieHdr(jar) },
  });
  cookiesOf(r, jar);
  return await r.text();
}

async function descargar(categoria: string, conv = "ORD") {
  const jar: Jar = {};
  const r1 = await fetch(ELEGIR, { headers: UA }); cookiesOf(r1, jar);
  const h1 = await r1.text();
  const re = /id="(ultimosLlamamientosForm:[^"]+)"[^>]*>\s*<span class="nombre">([^<]*)<\/span>/g;
  let id = "", m;
  while ((m = re.exec(h1))) if (m[2].trim().toLowerCase() === categoria.toLowerCase()) id = m[1];
  if (!id) throw new Error("categoría no encontrada en la web del SMS");
  const t2 = await ajax(ELEGIR, jar, { ultimosLlamamientosForm: "ultimosLlamamientosForm", "javax.faces.partial.ajax": "true", "javax.faces.source": id, "javax.faces.partial.execute": id, "javax.faces.partial.render": "@all", [id]: id, "javax.faces.ViewState": vsOf(h1) });
  if (!/ultimosLlamamientosBolsa/.test(t2)) throw new Error("el SMS no redirigió a la página de llamamientos");
  const r3 = await fetch(LL, { headers: { ...UA, Cookie: cookieHdr(jar) } }); cookiesOf(r3, jar);
  const h3 = await r3.text();
  const src = "ultimosLlamamientosBolsaForm:tipoConvocatoria";
  return await ajax(LL, jar, { ultimosLlamamientosBolsaForm: "ultimosLlamamientosBolsaForm", [src]: `TipoConvocatoria [id=${conv}]`, "javax.faces.partial.ajax": "true", "javax.faces.source": src, "javax.faces.partial.execute": src, "javax.faces.partial.render": "ultimosLlamamientosBolsaForm", "javax.faces.behavior.event": "change", "javax.faces.partial.event": "change", "javax.faces.ViewState": vsOf(h3) });
}

function parsear(html: string, conv = "ORD") {
  const actualizada = iso(html.match(/Actualizada a\s*(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? "");
  const filas: any[] = [];
  // Cada panel: "Orden de llamamientos para <tipo> visible" seguido de su tabla
  const marcas = [...html.matchAll(/title="Orden de llamamientos para ([^"]+?) visible"/g)];
  for (let k = 0; k < marcas.length; k++) {
    const nombramiento = marcas[k][1].trim();
    const desde = marcas[k].index!;
    const hasta = k + 1 < marcas.length ? marcas[k + 1].index! : html.length;
    const trozo = html.slice(desde, hasta);
    const cabecera = [...trozo.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => txt(x[1]).toLowerCase());
    const col = (nombre: string) => cabecera.findIndex((c) => c.startsWith(nombre));
    const cA = col("área"), cAm = col("ámbito"), cC = col("convocatoria"), cP = col("puntuación"), cF = col("último"), cT = col("tipo");
    const tbody = trozo.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
    for (const tr of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const td = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => txt(x[1]));
      if (td.length < 4 || cP < 0) continue;
      const raw = td[cP] ?? "";
      const puntos = parseFloat(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
      if (!isFinite(puntos)) continue;
      const area = td[cA] ?? "";
      filas.push({
        conv, nombramiento, area, area_num: ROMAN[area.replace(/^Área\s+/i, "").trim()] ?? "",
        ambito: td[cAm] ?? "", convocatoria: cC >= 0 ? td[cC] : "", puntos,
        fecha: cF >= 0 ? iso(td[cF]) : "", tipo_llamamiento: cT >= 0 ? td[cT] : "", actualizada,
      });
    }
  }
  return { actualizada, filas, paneles: marcas.map((x) => x[1]) };
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const { data: ok } = await sb.rpc("bolsa_sms_token_ok", { p_token: req.headers.get("x-cron-token") ?? "" });
  if (!ok) return new Response("no autorizado", { status: 401 });

  const solo = u.searchParams.get("categoria");
  const { data: cats } = await sb.rpc("bolsa_sms_categorias");
  const lista: string[] = solo ? [solo] : (cats ?? []);
  const res: any[] = [];
  for (const c of lista) {
    try {
      const p = parsear(await descargar(c));
      if (!p.filas.length) throw new Error("sin filas (¿ha cambiado la web?)");
      const { data, error } = await sb.rpc("bolsa_sms_guardar_llamamientos", { p_categoria: c, p_filas: p.filas });
      res.push({ categoria: c, actualizada: p.actualizada, paneles: p.paneles, filas: p.filas.length, guardadas: data, error: error?.message });
    } catch (e) {
      await sb.rpc("bolsa_sms_guardar_llamamientos", { p_categoria: c, p_filas: [], p_error: String(e) });
      res.push({ categoria: c, error: String(e) });
    }
  }
  return Response.json(res);
});
