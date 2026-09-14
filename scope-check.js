/* Détecte les identifiants référencés hors de leur portée (planteraient à l'exécution). */
const fs=require("fs");
const parser=require("/tmp/babel/node_modules/@babel/parser");
const traverse=require("/tmp/babel/node_modules/@babel/traverse").default;
const file=process.argv[2]||"index.html";
const src=fs.readFileSync(file,"utf8");
const m=src.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/);
if(!m){console.error("bloc babel introuvable");process.exit(1);}
const code=m[1];
const ast=parser.parse(code,{sourceType:"script",plugins:["jsx"]});
const GLOBALS=new Set(["window","document","console","Math","JSON","Date","Object","Array","String","Number","Boolean","Promise","Map","Set","WeakMap","RegExp","Error","isNaN","isFinite","parseInt","parseFloat","setTimeout","clearTimeout","setInterval","clearInterval","fetch","localStorage","navigator","location","crypto","indexedDB","AbortController","TextEncoder","TextDecoder","Intl","React","ReactDOM","Recharts","PropTypes","Babel","alert","confirm","prompt","requestAnimationFrame","URL","URLSearchParams","Uint8Array","btoa","atob","structuredClone","performance","undefined","NaN","Infinity","globalThis","process","module","require","exports","Notification","FileReader","Blob","CustomEvent","Event","HTMLElement","screen","history","matchMedia","IntersectionObserver","ResizeObserver","queueMicrotask","encodeURIComponent","decodeURIComponent","encodeURI","decodeURI","IDBKeyRange","PublicKeyCredential","Symbol","Proxy","Reflect","BigInt","WeakSet","ArrayBuffer","DataView","Float64Array","Int32Array"]);
const bad=[];
traverse(ast,{
  ReferencedIdentifier(path){
    const name=path.node.name;
    if(GLOBALS.has(name))return;
    if(path.scope.hasBinding(name,true))return;
    bad.push({name,line:path.node.loc?path.node.loc.line:"?"});
  }
});
if(bad.length){
  console.error("❌ "+bad.length+" référence(s) hors portée (planteraient à l'exécution) :");
  bad.slice(0,20).forEach(b=>console.error("   ligne "+b.line+" : "+b.name));
  process.exit(1);
}
console.log("✅ PORTÉE OK — aucun identifiant référencé hors de sa portée.");
