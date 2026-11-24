const { chromium } = require('playwright');
const path = require('path');
const C={cattle:'#8C4A2F',sheep:'#3F6B4F',goat:'#2E5C6E',gold:'#B8892B',danger:'#A13B2E',ink:'#262019'};
// [seconds, kind, color, big, small, icon]
const S=[
 [7,'title',C.ink,'4 problems every farmer has','Most don’t know they’re losing money because of them.','🐂'],
 [8,'prob',C.cattle,'Problem 1','You sell an ox, but you don’t know what it’s worth — so you take the buyer’s price.','💰'],
 [10,'sol',C.cattle,'Know your price','See what every animal and your whole herd is worth — updated weekly from Namibian market prices.','📈'],
 [8,'prob',C.sheep,'Problem 2','Records in your head or a notebook. Animals go missing. Treatments get forgotten.','📓'],
 [10,'sol',C.sheep,'Track every animal','Tag, births, treatments, sales, deaths — and a reminder before a treatment is due.','🏷️'],
 [8,'prob',C.goat,'Problem 3','Too few calves this year. The bull wasn’t checked. The breeding season came and went.','🐄'],
 [9,'sol',C.goat,'Get more calves','Season calendar and bull care tell you what to do and when — so your calving rate stays up.','📅'],
 [8,'prob',C.gold,'Problem 4','Money in, money out — but is the farm actually making a profit?','❓'],
 [9,'sol',C.gold,'See your profit','Sales and expenses side by side for each species — see what makes money and what doesn’t.','📊'],
 [7,'recap',C.ink,'Know your price.<br>Track every animal.<br>Get more calves.<br>See your profit.','',''],
 [6,'feat',C.sheep,'English · Afrikaans · Deutsch','Made for farms with weak signal.','📶'],
 [8,'end',C.ink,'TFNN','The Future of Namibian Farming.<br><b>Sign up today.</b>',''],
];
const html=(s,i)=>{const [d,k,c,big,small,ic]=s;const dark=['title','recap','end'].includes(k);
return `<html><body style="margin:0;width:1080px;height:1920px;background:${dark?c:'#EFEAD9'};font-family:'Roboto Slab','DejaVu Serif',serif;color:${dark?'#F8F5EA':C.ink};display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0 90px;box-sizing:border-box;position:relative">
<div style="position:absolute;top:0;left:0;right:0;height:26px;background:${k==='prob'?C.danger:c}"></div>
${k==='end'?'<img src="emblem.png" style="width:300px;border-radius:50%;margin-bottom:50px">':''}
${ic?`<div style="font-size:${k==='title'?220:200}px;margin-bottom:50px">${ic}</div>`:''}
${k==='prob'?`<div style="font-size:48px;letter-spacing:8px;color:${C.danger};font-weight:700;margin-bottom:20px">THE PROBLEM</div>`:''}
${k==='sol'?`<div style="font-size:48px;letter-spacing:8px;color:${c};font-weight:700;margin-bottom:20px">WITH TFNN</div>`:''}
<div style="font-size:${k==='end'?190:k==='recap'?88:k==='title'?96:110}px;font-weight:800;line-height:1.1">${big}</div>
<div style="font-size:54px;line-height:1.35;margin-top:50px;opacity:.9">${small}</div>
<div style="position:absolute;bottom:60px;font-size:34px;opacity:.6">TFNN · The Future of Namibian Farming</div>
</body></html>`};
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1080,height:1920}});
const list=[];
for(let i=0;i<S.length;i++){const f=path.resolve('build',`s${i}.html`);require('fs').writeFileSync(f,html(S[i],i));
 await p.goto('file://'+f);await p.screenshot({path:`build/s${i}.png`});list.push(S[i][0]);}
require('fs').writeFileSync('build/list.txt',list.map((d,i)=>`file 's${i}.png'\nduration ${d}`).join('\n')+`\nfile 's${S.length-1}.png'\n`);
await b.close();})();
