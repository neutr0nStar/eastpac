// Run characterization cases against the migrated JS module and print JSON results.
// Usage: node js_harness.mjs <module.js> <cases.json>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , modPath, casesPath] = process.argv;
const mod = await import(pathToFileURL(modPath).href);
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));

const camel = (s) => s.replace(/_+([a-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = (s) => camel(s).replace(/^./, (c) => c.toUpperCase());

function pick(obj, ...names) {
  for (const n of names) {
    if (n && obj != null && n in Object(obj)) return obj[n];
  }
  return undefined;
}

function norm(v, depth = 0) {
  if (depth > 20) return '<deep>';
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    return v;
  }
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => norm(x, depth + 1));
  if (v instanceof Set) return [...v].map((x) => norm(x, depth + 1));
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), norm(x, depth + 1)]));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (typeof x !== 'function') o[k.replace(/^#/, '')] = norm(x, depth + 1);
    return o;
  }
  return String(v);
}

const err = (e) => ({ error: e?.name || 'Error', message: String(e?.message ?? e).slice(0, 200) });

async function call(target, self, args) {
  if (typeof target === 'function') return { ok: norm(await target.apply(self, args)) };
  if (target === undefined) throw Object.assign(new Error('member not found'), { name: 'MissingExport' });
  return { ok: norm(target) };
}

const out = [];
for (const c of cases) {
  try {
    if (c.kind === 'class') {
      const Cls = pick(mod, c.js_target, pascal(c.target), c.target);
      if (typeof Cls !== 'function') throw Object.assign(new Error(`export ${c.js_target || c.target} not found`), { name: 'MissingExport' });
      let inst;
      try {
        inst = new Cls(...(c.ctor_args || []));
      } catch (e) {
        out.push({ id: c.id, result: err(e) });
        continue;
      }
      const steps = [];
      for (const s of c.calls || []) {
        try {
          steps.push(await call(pick(inst, s.js_method, camel(s.method), s.method), inst, s.args || []));
        } catch (e) {
          steps.push(err(e));
        }
      }
      out.push({ id: c.id, result: { ok: steps } });
    } else {
      const fn = pick(mod, c.js_target, camel(c.target), c.target);
      if (fn === undefined) throw Object.assign(new Error(`export ${c.js_target || c.target} not found`), { name: 'MissingExport' });
      out.push({ id: c.id, result: await call(fn, mod, c.args || []) });
    }
  } catch (e) {
    out.push({ id: c.id, result: err(e) });
  }
}
console.log(JSON.stringify(out));
