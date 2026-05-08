// Build the ha:bash module for Hyperlight
// Prepends polyfills to the esbuild bundle
import { readFileSync, writeFileSync } from "node:fs";

const polyfills = `
// ── QuickJS Polyfills for just-bash ──────────────────────────
if(typeof globalThis.URL==='undefined'){globalThis.URL=class URL{constructor(input,base){let full=String(input);if(base&&!full.match(/^[a-z]+:\\/\\//i)){full=String(base).replace(/\\/[^\\/]*$/,'/')+full}const m=full.match(/^(https?:)\\/\\/([^\\/:]+)(:\\d+)?(\\/[^?#]*)?(\\?[^#]*)?(#.*)?$/i);if(m){this.protocol=m[1];this.hostname=m[2];this.port=m[3]?m[3].slice(1):'';this.pathname=m[4]||'/';this.search=m[5]||'';this.hash=m[6]||'';this.host=this.hostname+(this.port?':'+this.port:'');this.origin=this.protocol+'//'+this.host;this.href=this.origin+this.pathname+this.search+this.hash;this.searchParams=new URLSearchParams(this.search);this.username='';this.password=''}else{this.href=full;this.protocol='';this.hostname='';this.port='';this.pathname=full;this.search='';this.hash='';this.host='';this.origin='';this.searchParams=new URLSearchParams();this.username='';this.password=''}}toString(){return this.href}}}
if(typeof globalThis.URLSearchParams==='undefined'){globalThis.URLSearchParams=class URLSearchParams{constructor(init){this._p=[];if(typeof init==='string'){const s=init.startsWith('?')?init.slice(1):init;for(const pair of s.split('&')){const[k,v]=pair.split('=');if(k)this._p.push([decodeURIComponent(k),decodeURIComponent(v||'')])}}}get(k){const p=this._p.find(([a])=>a===k);return p?p[1]:null}has(k){return this._p.some(([a])=>a===k)}toString(){return this._p.map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&')}entries(){return this._p[Symbol.iterator]()}[Symbol.iterator](){return this._p[Symbol.iterator]()}forEach(fn){this._p.forEach(([k,v])=>fn(v,k))}}}
if(typeof globalThis.Buffer==='undefined'){const _e=new TextEncoder();globalThis.Buffer={from(d,e){if(typeof d==='string'){if(e==='base64'){const b=atob(d);const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}return _e.encode(d)}if(d instanceof Uint8Array)return d;if(Array.isArray(d))return new Uint8Array(d);return new Uint8Array(0)},isBuffer(o){return o instanceof Uint8Array},concat(l){const t=l.reduce((s,b)=>s+b.length,0);const r=new Uint8Array(t);let o=0;for(const b of l){r.set(b,o);o+=b.length}return r},alloc(s){return new Uint8Array(s)},byteLength(s,e){if(typeof s==='string')return _e.encode(s).length;return s.length}}}
if(typeof globalThis.process==='undefined'){globalThis.process={env:{},nextTick(fn){queueMicrotask(fn)},execPath:'/usr/bin/node',mainModule:null,umask(){return 18},type:'renderer'}}
if(typeof globalThis.AbortController==='undefined'){globalThis.AbortController=class AbortController{constructor(){this.signal={aborted:false,addEventListener(){}}}abort(){this.signal.aborted=true}}}
if(typeof globalThis.crypto==='undefined'||!globalThis.crypto.randomUUID){if(!globalThis.crypto)globalThis.crypto={};globalThis.crypto.randomUUID=function(){const h='0123456789abcdef';let u='';for(let i=0;i<36;i++){if(i===8||i===13||i===18||i===23)u+='-';else u+=h[Math.floor(Math.random()*16)]}return u}}
if(typeof globalThis.setTimeout==='undefined'){globalThis.setTimeout=(fn)=>{fn();return 0};globalThis.clearTimeout=()=>{};globalThis.setInterval=()=>0;globalThis.clearInterval=()=>{}}
if(typeof globalThis.performance==='undefined'){globalThis.performance={now(){return Date.now()}}}
// ── End Polyfills ────────────────────────────────────────────
`;

const bundle = readFileSync("just-bash-bundle.js", "utf-8");
const output = polyfills + bundle;
writeFileSync("ha-bash-bundle.js", output);
console.log("ha-bash-bundle.js: " + (output.length / 1024).toFixed(0) + " KB");
