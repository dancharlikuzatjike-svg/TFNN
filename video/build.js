// Builds TFNN-4-problems-vo.mp4 (voice-over + real app screens + captions).
// Needs: node + playwright, ffmpeg, espeak-ng.  Run: node build.js
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path');
process.chdir(__dirname); fs.mkdirSync('build', { recursive: true });
const C = { cattle:'#8C4A2F', sheep:'#3F6B4F', goat:'#2E5C6E', gold:'#B8892B', danger:'#A13B2E', ink:'#262019' };
// kind, color, headline, spoken (for espeak), caption (shown), app screenshot
const S = [
 ['title',C.ink,'4 problems every farmer has','Every farmer has these four problems. Most don\'t even know they\'re losing money because of them.','Every farmer has these four problems. Most don\'t even know they\'re losing money because of them.',null],
 ['prob',C.danger,'Problem 1','Problem one. You sell an ox, but you don\'t really know what it\'s worth. So you take the buyer\'s price.','Problem one. You sell an ox, but you don\'t really know what it\'s worth. So you take the buyer\'s price.',null],
 ['sol',C.cattle,'Know your price','With T F N N, you see what every animal and your whole herd is worth, updated every week from Namibian market prices. Now you know your price before you sell.','With TFNN, you see what every animal and your whole herd is worth, updated every week from Namibian market prices. Now you know your price before you sell.','app-value.png'],
 ['prob',C.danger,'Problem 2','Problem two. Your records are in your head or a notebook. Animals go missing, and treatments get forgotten.','Problem two. Your records are in your head or a notebook. Animals go missing, and treatments get forgotten.',null],
 ['sol',C.sheep,'Track every animal','T F N N keeps a record of every animal: its tag, births, treatments, sales and deaths. And it reminds you before a treatment is due.','TFNN keeps a record of every animal: its tag, births, treatments, sales and deaths. And it reminds you before a treatment is due.','app-herd.png'],
 ['prob',C.danger,'Problem 3','Problem three. Too few calves this year. The bull wasn\'t checked, and the breeding season came and went.','Problem three. Too few calves this year. The bull wasn\'t checked, and the breeding season came and went.',null],
 ['sol',C.goat,'Get more calves','T F N N\'s season calendar and bull care tell you what to do and when, so your bulls are ready and your calving rate stays up.','TFNN\'s season calendar and bull care tell you what to do and when, so your bulls are ready and your calving rate stays up.','app-bull.png'],
 ['prob',C.danger,'Problem 4','Problem four. Money comes in, money goes out, but is the farm actually making a profit? Most farmers can\'t say.','Problem four. Money comes in, money goes out, but is the farm actually making a profit? Most farmers can\'t say.',null],
 ['sol',C.gold,'See your profit','T F N N puts your sales and expenses side by side for each species, so you can see what\'s making money and what isn\'t.','TFNN puts your sales and expenses side by side for each species, so you can see what\'s making money and what isn\'t.','app-value.png'],
 ['recap',C.ink,'Know your price.<br>Track every animal.<br>Get more calves.<br>See your profit.','Know your price. Track every animal. Get more calves. See your profit.','Know your price. Track every animal. Get more calves. See your profit.',null],
 ['sol',C.sheep,'English · Afrikaans · Deutsch','In English, Afrikaans and German, and made for farms with weak signal.','In English, Afrikaans and German, and made for farms with weak signal.','app-plan.png'],
 ['end',C.ink,'TFNN','T F N N. The Future of Namibian Farming. Sign up today.','TFNN. The Future of Namibian Farming. Sign up today.',null],
];
const dur = f => parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${f}`).toString());
const sh = (c) => execSync(c, { stdio: 'pipe' });
const frame = (s, cap) => { const [k,c,big,,,img] = s; const dark = ['title','recap','end'].includes(k);
 const label = k==='prob'?`<div style="font-size:46px;letter-spacing:8px;color:${C.danger};font-weight:700;margin-bottom:24px">THE PROBLEM</div>`:'';
 const body = img ? `
  <div style="position:absolute;top:70px;left:0;right:0;text-align:center"><div style="font-size:42px;letter-spacing:7px;color:${c};font-weight:700">WITH TFNN</div><div style="font-size:${big.length>20?58:84}px;font-weight:800;margin-top:10px">${big}</div></div>
  <div style="position:absolute;top:310px;left:252px;width:576px;height:1250px;border-radius:56px;background:#111;padding:14px;box-sizing:border-box;box-shadow:0 30px 60px rgba(0,0,0,.35)"><img src="../assets/${img}" style="width:100%;height:100%;object-fit:cover;object-position:top;border-radius:44px"></div>`
  : `<div style="position:absolute;top:0;left:0;right:0;bottom:380px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0 90px">
   ${k==='end'?'<img src="../assets/emblem.png" style="width:300px;border-radius:50%;margin-bottom:50px">':''}${label}
   <div style="font-size:${k==='end'?200:k==='recap'?92:k==='title'?100:150}px;font-weight:800;line-height:1.1">${big}</div></div>`;
 return `<html><body style="margin:0;width:1080px;height:1920px;background:${dark?c:'#EFEAD9'};font-family:'Roboto Slab','DejaVu Serif',serif;color:${dark?'#F8F5EA':C.ink};position:relative;overflow:hidden">
 <div style="position:absolute;top:0;left:0;right:0;height:26px;background:${k==='prob'?C.danger:c}"></div>${body}
 <div style="position:absolute;left:50px;right:50px;bottom:70px;height:230px;display:flex;align-items:center;justify-content:center;text-align:center;background:rgba(20,15,10,.88);color:#fff;border-radius:28px;padding:0 40px;font-size:48px;line-height:1.3;font-family:'DejaVu Sans',sans-serif;font-weight:600">${cap}</div></body></html>`; };
(async () => {
 S.forEach((s,i)=>sh(`espeak-ng -v en-us -s 135 -p 40 -w build/v${i}.wav "${s[3]}"`));
 const b = await chromium.launch(); const p = await b.newPage({ viewport:{width:1080,height:1920} });
 let list = '', n = 0, audio = '';
 for (let i=0;i<S.length;i++) {
  const sp = dur(`build/v${i}.wav`), D = sp + 1.4;
  sh(`ffmpeg -y -loglevel error -i build/v${i}.wav -af "adelay=400|400,apad,atrim=0:${D.toFixed(2)},aresample=44100" -ac 1 build/n${i}.wav`); audio += `file 'n${i}.wav'\n`;
  const chunks = S[i][4].match(/[^.?!]+[.?!]+/g).map(x=>x.trim());
  // merge very short chunks (<28 chars) into the next one so captions don't flash
  const merged=[]; chunks.forEach(c=>{ if(merged.length && merged[merged.length-1].length<28) merged[merged.length-1]+=' '+c; else merged.push(c); });
  // split long captions at the comma/colon nearest the middle so they stay within 3 short lines
  for (let m=0;m<merged.length;m++) { const t=merged[m]; if (t.length>85) { const mid=t.length/2; let best=-1; for (const mm of t.matchAll(/[,:] /g)) if (best<0||Math.abs(mm.index-mid)<Math.abs(best-mid)) best=mm.index; if (best>0) merged.splice(m,1,t.slice(0,best+1),t.slice(best+2)); } }
  const tot = merged.reduce((a,c)=>a+c.length,0);
  for (const c of merged) { const f = path.resolve(`build/f${n}.html`); fs.writeFileSync(f, frame(S[i], c)); await p.goto('file://'+f); await p.screenshot({path:`build/f${n}.png`});
   list += `file 'f${n}.png'\nduration ${(D*c.length/tot).toFixed(3)}\n`; n++; }
 }
 list += `file 'f${n-1}.png'\n`; await b.close();
 fs.writeFileSync('build/list.txt', list); fs.writeFileSync('build/a.txt', audio);
 sh(`cd build && ffmpeg -y -loglevel error -f concat -safe 0 -i list.txt -vf "fps=30,format=yuv420p,fade=t=in:st=0:d=0.5" -c:v libx264 -crf 20 v.mp4 && ffmpeg -y -loglevel error -f concat -safe 0 -i a.txt -c:a aac -b:a 160k voice.m4a && ffmpeg -y -loglevel error -i v.mp4 -i voice.m4a -c:v copy -c:a copy -shortest ../TFNN-4-problems-vo.mp4`);
 console.log('done', dur('TFNN-4-problems-vo.mp4'), 's');
})();
