import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const html = fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
const errs=[]; const vc=new VirtualConsole(); vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{virtualConsole:vc});
const d=dom.window.document;
// duplicate ids
const ids=[...d.querySelectorAll('[id]')].map(e=>e.id);
const dupes=ids.filter((v,i)=>ids.indexOf(v)!==i);
console.log('duplicate ids:', dupes.length?dupes:'none');
// labels -> controls
[...d.querySelectorAll('label[for]')].forEach(l=>{ if(!d.getElementById(l.getAttribute('for'))) console.log('label points nowhere:', l.getAttribute('for')); });
// buttons with type
const noType=[...d.querySelectorAll('button')].filter(b=>!b.getAttribute('type'));
console.log('buttons without type:', noType.length);
// lang/dir/title
console.log('html lang:', d.documentElement.lang, '| dir:', d.documentElement.dir, '| title:', d.title);
// references to ids used by JS
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1] + fs.readFileSync(new URL('../cloud.js', import.meta.url),'utf8');
const wanted=[...js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map(m=>m[1]);
const dynamic=new Set(['toast','draftList','scheduleList','storageSummary','signedEmail','signedSince','loginform','email','password','loginBtn','loginStatus','logout','file','drop','panelContent']);
const missing=[...new Set(wanted)].filter(id=>!d.getElementById(id) && !dynamic.has(id) && !/Count$/.test(id));
console.log('ids referenced by JS but absent at load:', missing.length?missing:'none');
console.log('parse errors:', errs.length?errs:'none');
