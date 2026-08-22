/**
 * MasterLocalization — request localization + string localizer modeled on
 * ASP.NET Core's RequestLocalizationMiddleware / IStringLocalizer:
 *
 *   master.useRequestLocalization({ defaultCulture: 'en', supportedCultures: ['en', 'de', 'fr-CA'],
 *       providers: ['query:culture', 'cookie:.Culture', 'accept-language'], resourcesDir: 'resources' })
 *   master.localization.addResources('de', { greeting: 'Hallo {name}', 'items.count': '{count} Artikel' });
 *   // resources/en.json, resources/de.json, resources/fr-CA.json are loaded from resourcesDir
 *
 *   ctx.culture / this.culture           -> 'de'
 *   this.localizer('greeting', { name })  -> 'Hallo Ann'   (IStringLocalizer["greeting", name])
 *   this.localizer.has('key'), this.localizer.culture, this.localizer.formatNumber(n), formatDate(d), formatCurrency(n, 'EUR')
 *
 * Culture resolution order = providers order; values are matched against supportedCultures with
 * fallback from 'fr-CA' -> 'fr' -> defaultCulture. Responses get Content-Language.
 */
import fs from 'node:fs';
import path from 'node:path';

export function parseAcceptLanguage(header) {
    if (!header) return [];
    return String(header).split(',').map((part, i) => {
        const [tag, ...params] = part.trim().split(';');
        let q = 1;
        for (const p of params) { const m = p.trim().match(/^q=([0-9.]+)$/i); if (m) q = parseFloat(m[1]); }
        return { tag: tag.trim(), q, i };
    }).filter(x => x.tag && x.tag !== '*').sort((a, b) => b.q - a.q || a.i - b.i).map(x => x.tag);
}

export class StringLocalizer {
    constructor(service, culture) {
        this.service = service;
        this.culture = culture;
        const fn = (key, params) => service.get(culture, key, params);
        Object.setPrototypeOf(fn, StringLocalizer.prototype);
        fn.service = service; fn.culture = culture;
        return fn;
    }
    has(key) { return this.service.has(this.culture, key); }
    get(key, params) { return this.service.get(this.culture, key, params); }
    formatNumber(n, opts) { return new Intl.NumberFormat(this.culture, opts).format(n); }
    formatCurrency(n, currency, opts) { return new Intl.NumberFormat(this.culture, { style: 'currency', currency, ...(opts || {}) }).format(n); }
    formatDate(d, opts) { return new Intl.DateTimeFormat(this.culture, opts).format(d instanceof Date ? d : new Date(d)); }
    withCulture(culture) { return new StringLocalizer(this.service, culture); }
}

export class LocalizationService {
    constructor(options = {}) {
        this.defaultCulture = options.defaultCulture || 'en';
        this.supportedCultures = [].concat(options.supportedCultures || [this.defaultCulture]);
        if (!this.supportedCultures.includes(this.defaultCulture)) this.supportedCultures.unshift(this.defaultCulture);
        this.providers = (options.providers && options.providers.length) ? options.providers : ['query:culture', 'cookie:.Culture', 'accept-language'];
        this.fallbackToParent = options.fallbackToParent !== false;
        this.setContentLanguage = options.setContentLanguage !== false;
        this._resources = new Map();     // culture (lowercase) -> Map(key -> string)
        this.missingKeyHandler = options.missingKeyHandler || null;
        if (options.resourcesDir) this.loadDirectory(options.resourcesDir, options.root);
        if (options.resources) for (const [culture, dict] of Object.entries(options.resources)) this.addResources(culture, dict);
    }

    /** Register strings for a culture (nested objects are flattened to dotted keys). */
    addResources(culture, dict) {
        const c = String(culture).toLowerCase();
        if (!this._resources.has(c)) this._resources.set(c, new Map());
        const map = this._resources.get(c);
        const walk = (obj, prefix) => {
            for (const [k, v] of Object.entries(obj || {})) {
                const key = prefix ? `${prefix}.${k}` : k;
                if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key); else map.set(key, v);
            }
        };
        walk(dict, '');
        return this;
    }
    /** Load <dir>/<culture>.json files (e.g. resources/en.json, resources/de-CH.json). */
    loadDirectory(dir, root) {
        const abs = path.isAbsolute(dir) ? dir : path.join(root || process.cwd(), dir);
        if (!fs.existsSync(abs)) return this;
        for (const f of fs.readdirSync(abs)) {
            if (!f.endsWith('.json')) continue;
            try { this.addResources(path.basename(f, '.json'), JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8'))); }
            catch (err) { throw new Error(`localization: cannot load ${path.join(abs, f)}: ${err.message}`); }
        }
        return this;
    }
    get cultures() { return [...this._resources.keys()]; }

    /** Match a requested culture against supportedCultures (exact, then parent language). */
    match(requested) {
        if (!requested) return null;
        const want = String(requested).trim();
        const lower = want.toLowerCase();
        const exact = this.supportedCultures.find(c => c.toLowerCase() === lower);
        if (exact) return exact;
        if (this.fallbackToParent && lower.includes('-')) {
            const parent = lower.split('-')[0];
            const p = this.supportedCultures.find(c => c.toLowerCase() === parent);
            if (p) return p;
        }
        // a supported region variant of a requested language (de -> de-DE)
        const variant = this.supportedCultures.find(c => c.toLowerCase().split('-')[0] === lower);
        return variant || null;
    }

    /** Resolve the request culture from the providers. -> { culture, source } */
    resolve(ctx) {
        const req = ctx.request || {};
        const headers = req.headers || {};
        const query = (ctx.requrl && ctx.requrl.query) || {};
        for (const provider of this.providers) {
            const [kind, arg] = String(provider).split(':');
            if (kind === 'query') {
                const m = this.match(query[arg || 'culture']);
                if (m) return { culture: m, source: `query:${arg || 'culture'}` };
            } else if (kind === 'cookie') {
                const name = arg || '.Culture';
                const raw = String(headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
                if (raw) {
                    let val = decodeURIComponent(raw.slice(name.length + 1));
                    const m2 = val.match(/c=([A-Za-z-]+)/);   // ASP.NET cookie format "c=de|uic=de"
                    if (m2) val = m2[1];
                    const m = this.match(val);
                    if (m) return { culture: m, source: `cookie:${name}` };
                }
            } else if (kind === 'accept-language') {
                for (const tag of parseAcceptLanguage(headers['accept-language'])) { const m = this.match(tag); if (m) return { culture: m, source: 'accept-language' }; }
            } else if (kind === 'header') {
                const m = this.match(headers[(arg || 'x-culture').toLowerCase()]);
                if (m) return { culture: m, source: `header:${arg}` };
            }
        }
        return { culture: this.defaultCulture, source: 'default' };
    }

    has(culture, key) { return this._lookup(culture, key) !== undefined; }
    /** IStringLocalizer[key]: culture -> parent culture -> default culture -> the key itself. */
    get(culture, key, params) {
        let value = this._lookup(culture, key);
        if (value === undefined) {
            if (typeof this.missingKeyHandler === 'function') { const v = this.missingKeyHandler(culture, key); if (v !== undefined) value = v; }
            if (value === undefined) value = key;
        }
        return typeof value === 'string' ? value.replace(/\{(\w+)\}/g, (m, k) => (params && params[k] !== undefined ? String(params[k]) : m)) : value;
    }
    _lookup(culture, key) {
        const chain = [];
        const c = String(culture || this.defaultCulture).toLowerCase();
        chain.push(c);
        if (c.includes('-')) chain.push(c.split('-')[0]);
        chain.push(String(this.defaultCulture).toLowerCase());
        for (const cu of chain) { const map = this._resources.get(cu); if (map && map.has(key)) return map.get(key); }
        return undefined;
    }
    localizer(culture) { return new StringLocalizer(this, culture || this.defaultCulture); }

    /** Pipeline middleware: sets ctx.culture / ctx.localizer and Content-Language. */
    middleware() {
        const self = this;
        return async function requestLocalization(ctx, next) {
            const r = self.resolve(ctx);
            ctx.culture = r.culture; ctx.cultureSource = r.source; ctx.localizer = self.localizer(r.culture);
            try { if (self.setContentLanguage && ctx.response && !ctx.response.headersSent) ctx.response.setHeader('Content-Language', r.culture); } catch (_) { /* ignore */ }
            await next();
        };
    }
}

export default LocalizationService;
