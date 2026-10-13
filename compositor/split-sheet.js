const fs=require('fs'),path=require('path'),{createCanvas,loadImage}=require('canvas');
const [,,dir,prefix,out,cols='4',cw='420']=process.argv;
(async()=>{const fl=fs.readdirSync(dir).filter(f=>f.startsWith(prefix+'_')&&f.endsWith('.jpg')).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
const C=+cols,CW=+cw,CH=Math.round(CW*1.25),R=Math.ceil(fl.length/C),c=createCanvas(C*CW,R*CH),d=c.getContext('2d');d.fillStyle='#fff';d.fillRect(0,0,c.width,c.height);
for(let i=0;i<fl.length;i++){const im=await loadImage(path.join(dir,fl[i]));const s=Math.min(CW/im.width,CH/im.height);const x=(i%C)*CW,y=((i/C)|0)*CH;
d.drawImage(im,x,y,im.width*s,im.height*s);d.fillStyle='#000';d.font='bold 16px sans-serif';d.fillText(fl[i].replace(prefix+'_','').replace('.jpg',''),x+6,y+20);}
fs.writeFileSync(out,c.toBuffer('image/jpeg',{quality:0.85}));console.log(out,fl.length);})();
