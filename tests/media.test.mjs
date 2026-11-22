import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const html = fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
const cloud = fs.readFileSync(new URL('../cloud.js', import.meta.url),'utf8');
const merged = html.replace('<script src="cloud.js"></script>', '<script>' + cloud + '</script>');
const errors = [];
const vc = new VirtualConsole(); vc.on('jsdomError', e => { if (!/scrollTo/.test(e.message)) errors.push(e.message); });
let xhrSent = null;
const dom = new JSDOM(merged, { runScripts:'dangerously', url:'https://x.github.io/p/', virtualConsole: vc,
  beforeParse(w) {
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    w.scrollTo = () => {};
    w.matchMedia = w.matchMedia || (q => ({ matches:false, media:q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }));
    // قائمة HTML الصحيحة لا تتضمن هذا العنصر — نضيف حاوية للتقدم إن لزم
    w.fetch = async (u, o={}) => {
      const url=String(u);
      const json=(o2,st=200)=>({ok:st<300,status:st,async text(){return JSON.stringify(o2)},async blob(){return new w.Blob(['b']);}});
      if (url.includes('grant_type=password')) return json({access_token:'t',refresh_token:'r',expires_at:Math.floor(Date.now()/1000)+3600,
        user:{id:'aaaaaaaa-1111-4111-8111-111111111111',email:'o@e.com'}});
      if (url.includes('/storage/v1/object/authenticated/')) return {ok:true,status:200,async blob(){return new w.Blob(['img']);},async text(){return '';}};
      if (o.method==='POST' && url.includes('/rest/v1/imprint_posts')) return json([{id:'p1',media_path:'aaaaaaaa-1111-4111-8111-111111111111/x.png'}]);
      if (url.includes('/rest/v1/imprint_posts')) return json([]);
      return json({});
    };
    // stub XHR للرفع
    w.XMLHttpRequest = class {
      constructor(){ this.headers={}; this.upload={}; }
      open(m,u){ this.m=m; this.u=u; }
      setRequestHeader(k,v){ this.headers[k]=v; }
      send(body){ xhrSent={method:this.m,url:this.u,headers:this.headers,size:body.size};
        setTimeout(()=>{ this.status=200; this.responseText='{}'; this.onload(); }, 10); }
    };
  }});
const w=dom.window, $=id=>w.document.getElementById(id);
const log=[]; const check=(n,c,x='')=>log.push((c?'PASS ':'FAIL ')+n+(x?' :: '+x:''));
const tick=(ms=80)=>new Promise(r=>setTimeout(r,ms));
const mkFile=(name,type,size)=>{ const f=new w.File(['x'],name,{type}); Object.defineProperty(f,'size',{value:size}); return f; };
(async()=>{
  await tick(150);
  // دخول
  $('accountBtn').click(); await tick();
  $('email').value='o@e.com'; $('password').value='p';
  $('loginform').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})); await tick(120);

  // ملف بصيغة ممنوعة
  w.setFile(mkFile('a.exe','application/x-msdownload',10)); await tick(20);
  check('bad mime rejected', /غير مدعوم|غير مسموحة|الصيغة/.test($('status').textContent), $('status').textContent);

  // ملف كبير
  w.setFile(mkFile('big.mp4','video/mp4',200*1024*1024)); await tick(20);
  check('oversize rejected', /١٠٠/.test($('status').textContent), $('status').textContent);

  // ملف صورة صالح
  w.setFile(mkFile('pic.png','image/png',2048)); await tick(20);
  check('valid image accepted', $('uploaded').style.display === 'flex');
  check('thumb rendered', !!$('thumbHolder').querySelector('img'));
  check('preview rendered', !!$('videoBox').querySelector('img'));

  // حفظ مع رفع
  $('title').value='مع صورة'; w.document.querySelectorAll('.platform')[0].click();
  $('draft').click(); await tick(400);
  check('upload sent', !!xhrSent);
  check('upload path in own folder', xhrSent && xhrSent.url.includes('/imprint-media/aaaaaaaa-1111-4111-8111-111111111111/'), xhrSent&&xhrSent.url);
  check('upload uses apikey + bearer', xhrSent && xhrSent.headers.apikey.startsWith('sb_publishable_') && xhrSent.headers.Authorization==='Bearer t');
  check('upload content-type set', xhrSent && xhrSent.headers['Content-Type']==='image/png');
  check('save ok after upload', /تم حفظ المسودة/.test($('status').textContent), $('status').textContent);

  console.log(log.join('\n'));
  console.log('JS errors:', errors.length?errors:'none');
  const f=log.filter(l=>l.startsWith('FAIL'));
  console.log('SUMMARY:', log.length-f.length,'passed,',f.length,'failed');
  process.exit(f.length||errors.length?1:0);
})();
