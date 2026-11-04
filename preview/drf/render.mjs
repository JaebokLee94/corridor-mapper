import { boundsOf } from "../surf/map.mjs";

// Display affine transform only: each axis retains metres; inference never sees pixels.
export const mapToScreen=(p,c,b)=>[b.x+b.w/2+(p[0]-c.cx)*c.scaleX,b.y+b.h/2-(p[1]-c.cy)*c.scaleY];
export const mapToWorld=(p,c,b)=>[c.cx+(p[0]-b.x-b.w/2)/c.scaleX,c.cy-(p[1]-b.y-b.h/2)/c.scaleY];
export function zoomMap(c,factor,anchor,box) {
  const p=mapToWorld(anchor,c,box),scaleX=Math.max(.05,Math.min(100000,c.scaleX*factor)),scaleY=Math.max(.05,Math.min(100000,c.scaleY*factor));
  return {cx:p[0]-(anchor[0]-box.x-box.w/2)/scaleX,cy:p[1]+(anchor[1]-box.y-box.h/2)/scaleY,scaleX,scaleY};
}

const UI_FONT='-apple-system, BlinkMacSystemFont, "Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", Arial, sans-serif';
const MATH_FONT='"STIX Two Math", "STIX Two Text", "Latin Modern Math", "Cambria Math", "Times New Roman", serif';
const uiFont=(size,weight=400) => `${weight} ${size}px ${UI_FONT}`;
const mathFont=(size,italic) => `${italic ? 'italic ' : ''}${size}px ${MATH_FONT}`;

// Paper notation inside $…$: Latin and lowercase Greek letters italic; digits, operators and
// uppercase Greek upright; _x, _{xy} subscripts and ^x superscripts. Scripts keep the 14 px floor.
function richRuns(text,size,weight) {
  const runs=[],mathSize=Math.round(size*1.12),scriptSize=Math.max(14,Math.round(mathSize*.72));
  const push=(value,font,dy=0,script=0) => {
    const last=runs.at(-1);
    if (last && !script && !last.script && last.font===font) last.text+=value;
    else runs.push({text:value,font,dy,script});
  };
  text.split('$').forEach((part,k) => {
    if (!part) return;
    if (k%2===0) { push(part,uiFont(size,weight)); return; }
    for (let i=0;i<part.length;) {
      const c=part[i];
      if ((c==='_' || c==='^') && i+1<part.length) {
        let body;
        if (part[i+1]==='{') { const end=part.indexOf('}',i+2),stop=end<0 ? part.length : end;body=part.slice(i+2,stop);i=stop+1; }
        else { body=part[i+1];i+=2; }
        const italic=/^\p{L}$/u.test(body) && !/[Α-Ω]/.test(body);
        push(body,mathFont(scriptSize,italic),c==='_' ? mathSize*.26 : -mathSize*.42,c==='_' ? 1 : 2);
        continue;
      }
      const letter=part.slice(i).match(/^\p{L}\p{M}*/u)?.[0];
      if (letter) { push(letter,mathFont(mathSize,!/^[Α-Ω]/.test(letter)));i+=letter.length; }
      else { push(c,mathFont(mathSize,false));i++; }
    }
  });
  return runs;
}
function drawRich(ctx,text,x,y,{size=14,weight=400,align='left',color}={}) {
  const runs=richRuns(text,size,weight),starts=[];let cursor=0;
  runs.forEach((run,i) => {
    ctx.font=run.font;run.width=ctx.measureText(run.text).width;
    // A subscript directly after a superscript (or vice versa) stacks, as in χ²₁.
    const stacked=run.script && runs[i-1]?.script && runs[i-1].script!==run.script;
    starts.push(stacked ? starts[i-1] : cursor);
    cursor=Math.max(cursor,starts[i]+run.width);
  });
  const origin=align==='center' ? x-cursor/2 : align==='right' ? x-cursor : x;
  ctx.save();ctx.textAlign='left';if (color) ctx.fillStyle=color;
  runs.forEach((run,i) => { ctx.font=run.font;ctx.fillText(run.text,origin+starts[i],y+run.dy); });
  ctx.restore();
  return cursor;
}

function drawGrid(ctx,box,xs,ys,color) {
  ctx.save();ctx.strokeStyle=color;ctx.lineWidth=1;ctx.setLineDash([]);ctx.beginPath();
  for (const x of xs) if (x>box.x+1 && x<box.x+box.w-1) {ctx.moveTo(x,box.y);ctx.lineTo(x,box.y+box.h);}
  for (const y of ys) if (y>box.y+1 && y<box.y+box.h-1) {ctx.moveTo(box.x,y);ctx.lineTo(box.x+box.w,y);}
  ctx.stroke();ctx.restore();
}

function metreTicks(min,max) {
  const first=Math.ceil(min/10);
  return Array.from({length:Math.max(0,Math.floor(max/10)-first+1)},(_,i)=>(first+i)*10);
}

// White-based sequential colors affect drawing only; zero stays transparent.
const palettes = {
  Dbar: [[255,255,255],[255,225,143],[255,172,66],[239,100,29],[184,41,20]],
  betaHat: [[255,255,255],[214,233,249],[145,195,229],[61,142,196],[8,81,156]],
};
const colorAt = (t, palette) => {
  const p = Math.max(0,Math.min(1,t)) * (palette.length-1), i = Math.min(palette.length-2,Math.floor(p));
  return palette[i].map((v,k) => Math.round(v+(palette[i+1][k]-v)*(p-i)));
};
const rgb = (c) => `rgb(${c.join(",")})`;
const numberLabel = (x) => !Number.isFinite(x) ? "—" : x !== 0 && (Math.abs(x) < .001 || Math.abs(x) >= 1e4) ? x.toExponential(1) : Number(x.toPrecision(3)).toString();

/** Presentation only. Input field is iy*nx+ix with y ascending; canvas y is inverted.
 * O(nx*ny + history pairs + displayed paths) per field update; O(nx*ny) heatmap memory.
 * Scene geometry sets display bounds; truth overlays are optional and never sent to field.
 */
export class DrfMap {
  constructor(canvas, onInspect) {
    this.canvas = canvas;
    this.onInspect = onInspect;
    this.state = {};
    this.auto = true;
    this.camera = null;
    this.defaultScale = null;
    this.pending = false;
    this.pointer = null;
    this.heat = document.createElement("canvas");
    this.maxValue = 0;
    const resize=new ResizeObserver(() => { if (this.auto) this.camera = null; this.draw(); });
    resize.observe(canvas);
    const dashboard=canvas.closest?.('.map-panel')?.parentElement;
    if (dashboard) resize.observe(dashboard);
    new MutationObserver(() => this.draw()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      // At the limiting axis, another zoom-out restores the view; simulation state is untouched.
      const atFloor=this.camera && this.defaultScale && Math.max(this.defaultScale.scaleX/this.camera.scaleX,this.defaultScale.scaleY/this.camera.scaleY)>=1-1e-12;
      if (e.deltaY>0 && atFloor) this.fit();
      else this.zoom(Math.exp(-e.deltaY*.001),[e.offsetX,e.offsetY]);
    }, { passive:false });
    canvas.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; canvas.setPointerCapture(e.pointerId); this.pointer = [e.clientX,e.clientY]; });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.camera || !this.box) return;
      if (this.pointer) {
        this.camera.cx -= (e.clientX-this.pointer[0])/this.camera.scaleX;
        this.camera.cy += (e.clientY-this.pointer[1])/this.camera.scaleY;
        this.pointer = [e.clientX,e.clientY]; this.auto = false; this.draw(); this.onCameraChange?.();
      }
      const [x,y] = mapToWorld([e.offsetX,e.offsetY],this.camera,this.box), g=this.state.grid;
      if (!g) return;
      const d=g.domain ?? [g.xmin,g.xmax,g.ymin,g.ymax], dx=(d[1]-d[0])/g.nx, dy=(d[3]-d[2])/g.ny;
      const ix=Math.floor((x-d[0])/dx), iy=Math.floor((y-d[2])/dy);
      this.onInspect?.({ x,y,index:ix>=0 && ix<g.nx && iy>=0 && iy<g.ny ? iy*g.nx+ix : -1 });
    });
    for (const name of ["pointerup","pointercancel","lostpointercapture"]) canvas.addEventListener(name,() => { this.pointer=null; });
  }
  set(state) {
    if (state.mode==='geometry') state={...state,aspectMode:'equal'};
    const previous=this.state;
    this.state=state;
    if (state.aspectMode !== previous.aspectMode) {this.auto=true;this.camera=null;}
    if (this.auto && (state.grid !== previous.grid || state.walls !== previous.walls)) this.camera=null;
    if (state.frame !== previous.frame || state.grid !== previous.grid || state.heatField !== previous.heatField || state.scaleMode !== previous.scaleMode) this.buildHeat();
    this.draw();
  }
  buildHeat() {
    const {grid:g,frame,heatField="Dbar",scaleMode="linear"}=this.state;
    if (!g) {this.heat.width=1;this.heat.height=1;this.maxValue=0;return;}
    this.heat.width=g.nx; this.heat.height=g.ny;
    const values=frame?.[heatField], ctx=this.heat.getContext("2d"), data=ctx.createImageData(g.nx,g.ny);
    this.maxValue=0;
    if (values) for (const v of values) if (Number.isFinite(v) && v>this.maxValue) this.maxValue=v;
    const denominator=scaleMode === "log" ? Math.log1p(this.maxValue) : this.maxValue, palette=palettes[heatField] ?? palettes.Dbar;
    // Formula: image row = ny-1-iy. World y is never reordered in inference data.
    for (let iy=0;iy<g.ny;iy++) for (let ix=0;ix<g.nx;ix++) {
      const value=Math.max(0,values?.[iy*g.nx+ix] ?? 0), t=denominator>0 ? (scaleMode === "log" ? Math.log1p(value) : value)/denominator : 0;
      const at=4*((g.ny-1-iy)*g.nx+ix);
      data.data.set([...colorAt(t,palette),values && Number.isFinite(value) && value>0 ? 255 : 0],at);
    }
    ctx.putImageData(data,0,0);
  }
  fit(fullDomain=false) { this.fullDomain=fullDomain;this.auto=true;this.camera=null;this.draw();this.onCameraChange?.(); }
  zoom(factor,anchor) {
    if (!this.camera || !this.box || !this.defaultScale) return;
    factor=Math.max(factor,this.defaultScale.scaleX/this.camera.scaleX,this.defaultScale.scaleY/this.camera.scaleY);
    if (factor===1) return;
    this.camera=zoomMap(this.camera,factor,anchor ?? [this.box.x+this.box.w/2,this.box.y+this.box.h/2],this.box);
    this.auto=false; this.draw();this.onCameraChange?.();
  }
  draw() {
    if (this.pending) return;
    this.pending=true;
    requestAnimationFrame(() => { this.pending=false; this.paint(this.canvas,window.devicePixelRatio || 1); });
  }
  paint(target,ratio) {
    const width=this.canvas.clientWidth,height=this.canvas.clientHeight;
    if (width<1 || height<1) return;
    target.width=Math.round(width*ratio); target.height=Math.round(height*ratio);
    const ctx=target.getContext("2d"), css=getComputedStyle(document.documentElement), token=(name,fallback) => css.getPropertyValue(`--color-${name}`).trim() || fallback;
    const ink=token("ink"),muted=token("ink-muted"),line=token("line"),evalColor=token("eval"),background=token("plot-bg");
    const trackColor=token("track","#1c5cab"),ellipseColor=token("ellipse","#1d9b79"),proxyColor=token("proxy","#b8237a"),truthColor=token("truth",ink);
    ctx.scale(ratio,ratio); ctx.fillStyle=background; ctx.fillRect(0,0,width,height);
    ctx.font=uiFont(14);
    // 52 px left margin keeps y tick labels clear of the rotated axis title.
    const geometry=this.state.mode === "geometry",box={ x:52,y:16,w:Math.max(1,width-(geometry ? 68 : 116)),h:Math.max(1,height-62) }, g=this.state.grid;
    const domain=g?.domain ?? this.state.domain ?? (g ? [g.xmin,g.xmax,g.ymin,g.ymax] : [0,60,0,30]);
    // Static scene bounds keep all spatial views fixed as vehicles leave the visible map.
    // Wall candidates and measured poses affect overlays only, never the camera or inference.
    const xRange=geometry && this.state.xRange;
    const wallPoints=this.state.walls?.flat(),cameraBounds=this.state.cameraBounds;
    const bounds=(!this.fullDomain || xRange) && cameraBounds
      ? {xmin:cameraBounds[0],xmax:cameraBounds[1],ymin:cameraBounds[2],ymax:cameraBounds[3]}
      : (!this.fullDomain || xRange) && wallPoints?.length ? boundsOf(wallPoints) : {xmin:domain[0],xmax:domain[1],ymin:domain[2],ymax:domain[3]};
    const panel=this.canvas.closest?.('.map-panel');
    // CSS owns the full card size; fit metres inside it without shrinking the frame.
    // CSS pixels/metre: every viewport and visible-range change updates the zoom floor.
    let scaleX=box.w/(Math.max(1,bounds.xmax-bounds.xmin)*1.04),scaleY=box.h/(Math.max(1,bounds.ymax-bounds.ymin)*1.04);
    if (this.state.aspectMode==='equal') scaleX=scaleY=Math.min(scaleX,scaleY);
    if (xRange) {
      // Exact horizontal limits and equal metres: narrow only when needed to fit tall walls.
      const span=xRange[1]-xRange[0],w=Math.min(box.w,box.h*span/(Math.max(1,bounds.ymax-bounds.ymin)*1.04));
      box.x+=(box.w-w)/2;box.w=w;scaleX=scaleY=w/span;
    }
    this.defaultScale={scaleX,scaleY};
    if (!this.camera) {
      this.camera={cx:xRange ? (xRange[0]+xRange[1])/2 : (bounds.xmin+bounds.xmax)/2,cy:(bounds.ymin+bounds.ymax)/2,scaleX,scaleY};
    } else {
      const factor=Math.max(1,scaleX/this.camera.scaleX,scaleY/this.camera.scaleY);
      if (factor>1) this.camera=zoomMap(this.camera,factor,[box.x+box.w/2,box.y+box.h/2],box);
    }
    const c=this.camera,screen=(p) => mapToScreen(p,c,box),lo=mapToWorld([box.x,box.y+box.h],c,box),hi=mapToWorld([box.x+box.w,box.y],c,box);
    // Fixed world grid: zoom changes its pixel spacing, never its 10 m interval.
    const xs=metreTicks(lo[0],hi[0]),ys=metreTicks(lo[1],hi[1]);
    if (target===this.canvas) {
      this.box=box;
      this.canvas.dataset.view=JSON.stringify({xmin:lo[0],xmax:hi[0],ymin:lo[1],ymax:hi[1],pixelsPerMetreX:c.scaleX,pixelsPerMetreY:c.scaleY,aspectMode:this.state.aspectMode ?? 'fill',plotWidth:box.w,plotHeight:box.h,auto:this.auto});
    }
    ctx.save();ctx.beginPath();ctx.rect(box.x,box.y,box.w,box.h);ctx.clip();
    if (g && this.state.frame && !geometry) {
      const p=screen([domain[0],domain[3]]),q=screen([domain[1],domain[2]]);
      ctx.imageSmoothingEnabled=false; ctx.drawImage(this.heat,p[0],p[1],q[0]-p[0],q[1]-p[1]);
    }
    drawGrid(ctx,box,xs.map(x=>screen([x,0])[0]),ys.map(y=>screen([0,y])[1]),token('grid'));
    const path=(points,color,width=2,dash=[],alpha=1,cap=dash.length ? 'butt' : 'round') => {
      if (!points?.length) return;
      ctx.beginPath();ctx.globalAlpha=alpha;ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.lineJoin='round';ctx.lineCap=cap;
      points.forEach((p,i) => { const [x,y]=screen(p); i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y); });ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
    };
    // One arc per marker; a surface-coloured ring keeps overlapping markers legible.
    const marker=(p,{r=4,fill,stroke,ring=0,ringColor=background,lineWidth=2}) => {
      if (!p) return;
      const point=screen(p),[x,y]=point;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);
      if (fill) { if (ring) { ctx.lineWidth=ring*2;ctx.strokeStyle=ringColor;ctx.stroke(); } ctx.fillStyle=fill;ctx.fill(); }
      if (stroke) { ctx.lineWidth=lineWidth;ctx.strokeStyle=stroke;ctx.stroke(); }
      return point;
    };
    const square=(p,size,color,lineWidth=1.5) => { if (!p) return; const [x,y]=screen(p);ctx.beginPath();ctx.rect(x-size/2,y-size/2,size,size);ctx.fillStyle=background;ctx.fill();ctx.lineWidth=lineWidth;ctx.strokeStyle=color;ctx.stroke(); };
    const {layers={},wire,truth,walls=[],proxy=[],candidates=[],observed=[],history=[]}=this.state;
    // Truth and other overlays stay behind the supported patches. Each patch is
    // a separate path: do not join candidates or snap their geometry to truth.
    const supportedPatches=[];
    // Drawing budget only: the estimator still receives every measured path.
    const ellipseTotal=(wire?.configs ?? []).reduce((sum,config)=>sum+(config.paths?.length ?? 0),0),ellipseStride=Math.max(1,Math.ceil(ellipseTotal/600));
    let ellipseIndex=0,ellipseShown=0;
    if (layers.showEllipses) {
      // Stroke the union once: overlapping ranges must not accumulate opacity.
      // Keep each ellipse a separate subpath behind walls, candidates and vehicles.
      ctx.beginPath();ctx.globalAlpha=.28;ctx.strokeStyle=ellipseColor;ctx.lineWidth=.75;
      ctx.setLineDash([]);ctx.lineJoin='round';ctx.lineCap='round';
      for (const config of wire?.configs ?? []) {
        const a=config.pHat_i,b=config.pHat_j,dx=b[0]-a[0],dy=b[1]-a[1],distance=Math.hypot(dx,dy),angle=Math.atan2(dy,dx),cos=Math.cos(angle),sin=Math.sin(angle);
        for (const q of config.paths) {
          if (ellipseIndex++%ellipseStride!==0 || !(q.dHat>distance)) continue;
          const major=q.dHat/2,minor=Math.sqrt(major*major-distance*distance/4);
          for (let k=0;k<=96;k++) {
            const t=k*2*Math.PI/96,x=major*Math.cos(t),y=minor*Math.sin(t);
            const [sx,sy]=screen([(a[0]+b[0])/2+x*cos-y*sin,(a[1]+b[1])/2+x*sin+y*cos]);
            k===0 ? ctx.moveTo(sx,sy) : ctx.lineTo(sx,sy);
          }
          ellipseShown++;
        }
      }
      ctx.stroke();ctx.globalAlpha=1;
    }
    if (target===this.canvas && geometry) {
      this.canvas.dataset.ellipseTotal=String(ellipseTotal);this.canvas.dataset.ellipseShown=String(ellipseShown);
      const stats=panel?.querySelector?.('#ellipseStats');
      if (stats) stats.textContent=layers.showEllipses ? `${ellipseShown} ellipses shown / ${ellipseTotal} ranges` : 'Ellipses hidden';
    }
    if (layers.showTruth) for (const wall of walls) path(wall,truthColor,geometry ? 1.75 : 2,[7,5]);
    if (layers.showObserved) for (const p of observed) square(p,9,evalColor);
    if (layers.showProxy) {
      for (const p of proxy) marker(p,{r:2.75,fill:proxyColor,ring:1.25});
      for (const c of candidates) {
        const supported=c.status==='supported',pending=c.status==='pending',color=supported?'#009e73':pending?'#777777':'#c54b28';
        if (supported) {
          const points=[],tx=Math.cos(c.phi),ty=Math.sin(c.phi);
          for (let k=0;k<=20;k++) { const u=-c.ell+2*c.ell*k/20,b=.5*c.kappa*u*u*c.sg;
            points.push([c.center[0]+u*tx-b*ty,c.center[1]+u*ty+b*tx]); }
          supportedPatches.push(points);
        } else if (pending) marker(c.center,{r:2.5,stroke:color,lineWidth:1.25});
        else { const [x,y]=screen(c.center);ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.moveTo(x-2.5,y-2.5);ctx.lineTo(x+2.5,y+2.5);ctx.moveTo(x-2.5,y+2.5);ctx.lineTo(x+2.5,y-2.5);ctx.stroke(); }
      }
    }
    if (layers.showSpecular || layers.showDiffuse) for (const config of truth?.configs ?? []) {
      if (layers.showSpecular) for (const q of config.specular ?? []) marker(q.s,{r:4.5,stroke:evalColor,lineWidth:1.75});
      if (layers.showDiffuse) for (const q of config.diffuse ?? []) marker(q.s,{r:2.25,fill:evalColor});
    }
    if (layers.showVehicles) {
      const tracks=new Map();
      for (const snapshot of history.filter(s => s.t <= (this.state.frame?.t ?? 0))) for (const config of snapshot.configs ?? []) for (const [id,p] of [[config.i,config.pHat_i],[config.j,config.pHat_j]]) {
        if (!tracks.has(id)) tracks.set(id,[]);
        const track=tracks.get(id); if (track.at(-1)?.t !== snapshot.t) track.push({t:snapshot.t,p});
      }
      const current=new Map();
      for (const config of wire?.configs ?? []) { current.set(config.i,config.pHat_i);current.set(config.j,config.pHat_j); }
      // A casing separates tracks from ellipses and heat cells.
      const color=geometry ? trackColor : token("field-track",ink),casing=geometry ? background : token("field-casing",background);
      for (const track of tracks.values()) {
        const points=track.map((q) => q.p);
        path(points,casing,geometry ? 5.5 : 4.5,[],geometry ? .9 : .7);path(points,color,geometry ? 2.5 : 1.75);
        if (points.length>1) square(points[0],geometry ? 7 : 6,color);
      }
      const labels=[],positions=[...current].map(([id,p])=>[id,marker(p,{r:geometry ? 5.5 : 4.5,fill:color,ring:2,ringColor:casing})]);
      ctx.font=uiFont(14,600);
      for (const [id,[x,y]] of positions) {
        const text=`V${id}`,tw=ctx.measureText(text).width;
        const side=tw/2+16,candidates=[[x,y-15],[x,y+27],[x-side,y+6],[x+side,y+6],[x-side,y-18],[x-side,y+30],[x+side,y-18],[x+side,y+30]];
        for (let offset=39;offset<=box.h;offset+=24) candidates.push([x,y-offset],[x,y+offset+12],[x-side,y-offset],[x-side,y+offset+12]);
        const position=candidates.find(([lx,ly])=> {
          const left=lx-tw/2-6,right=lx+tw/2+6,top=ly-18,bottom=ly+6;
          return left>=box.x+2 && right<=box.x+box.w-2 && top>=box.y+2 && bottom<=box.y+box.h-2
            && !labels.some(a=>left<a.right && right>a.left && top<a.bottom && bottom>a.top)
            && !positions.some(([, [vx,vy]])=>left<vx+7 && right>vx-7 && top<vy+7 && bottom>vy-7);
        });
        // Keep every vehicle dot/track; omit only a number that has no room in the plot.
        if (!position) continue;
        const [lx,ly]=position,left=lx-tw/2-6;
        labels.push({left,right:lx+tw/2+6,top:ly-18,bottom:ly+6});
        if (lx!==x || ly!==y-15) { ctx.beginPath();ctx.strokeStyle=muted;ctx.lineWidth=1;ctx.moveTo(x,y);ctx.lineTo(Math.max(left,Math.min(lx+tw/2+6,x)),ly-6);ctx.stroke(); }
        ctx.beginPath();ctx.roundRect?.(left,ly-18,tw+12,24,7);ctx.globalAlpha=.92;ctx.fillStyle=background;ctx.fill();ctx.globalAlpha=1;
        ctx.lineWidth=1;ctx.strokeStyle=line;ctx.stroke();
        ctx.textAlign="center";ctx.fillStyle=ink;ctx.fillText(text,lx,ly);
      }
    }
    // Paint every casing first so overlapping patch casings cannot erase green
    // support. Flat caps preserve endpoint gaps instead of extending each line.
    for (const points of supportedPatches) path(points,background,8,[],1,'butt');
    for (const points of supportedPatches) path(points,'#009e73',5,[],1,'butt');
    ctx.restore();
    ctx.font=uiFont(14);ctx.fillStyle=muted;ctx.strokeStyle=line;ctx.lineWidth=1;
    ctx.strokeRect(box.x,box.y,box.w,box.h);
    // Sparse labels at extreme zoom-out avoid overlaps; grid lines stay at 10 m.
    const labelStepX=Math.max(1,Math.ceil(48/(c.scaleX*10))),labelStepY=Math.max(1,Math.ceil(24/(c.scaleY*10)));
    for (const x of xs) if ((x/10)%labelStepX===0) { const sx=screen([x,0])[0];ctx.textAlign="center";ctx.fillText(String(x),sx,box.y+box.h+20); }
    for (const y of ys) if ((y/10)%labelStepY===0) { const sy=screen([0,y])[1];ctx.textAlign="right";ctx.fillText(String(y),box.x-9,sy+5); }
    drawRich(ctx,"$x$ [m]",box.x+box.w/2,height-8,{align:"center",color:muted});
    ctx.save();ctx.translate(17,box.y+box.h/2);ctx.rotate(-Math.PI/2);drawRich(ctx,"$y$ [m]",0,0,{align:"center",color:muted});ctx.restore();
    ctx.font=uiFont(14);ctx.fillStyle=muted;
    if (geometry) {
      if (!this.state.frame) { ctx.fillStyle=muted;ctx.textAlign="center";ctx.fillText(layers.showTruth ? "Wall preview · evaluation only" : "Run to show measured ranges and trajectories.",box.x+box.w/2,box.y+box.h/2); }
      return;
    }
    // Colour bar spans the plot height minus its two end labels.
    const palette=palettes[this.state.heatField ?? "Dbar"],barX=width-42,barY=box.y+22,barH=Math.max(1,box.h-44),gradient=ctx.createLinearGradient(0,barY+barH,0,barY);
    palette.forEach((value,i) => gradient.addColorStop(i/(palette.length-1),rgb(value)));
    ctx.fillStyle=gradient;ctx.fillRect(barX,barY,12,barH);ctx.strokeStyle=line;ctx.strokeRect(barX,barY,12,barH);ctx.fillStyle=muted;ctx.textAlign="center";
    ctx.fillText(numberLabel(this.maxValue),barX+6,barY-7);ctx.fillText("0",barX+6,barY+barH+17);
    if (!this.state.frame) { ctx.fillStyle=muted;ctx.textAlign="center";ctx.fillText("No accumulated field yet.",box.x+box.w/2,box.y+box.h/2); }
  }
  async png() {
    const plot=document.createElement("canvas"),out=document.createElement("canvas"),ratio=300/96;
    this.paint(plot,ratio);out.width=plot.width;out.height=plot.height+Math.round(86*ratio);
    const ctx=out.getContext("2d"),css=getComputedStyle(document.documentElement);
    ctx.fillStyle=css.getPropertyValue('--color-plot-bg').trim();ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(plot,0,86*ratio);ctx.scale(ratio,ratio);
    ctx.fillStyle=css.getPropertyValue('--color-ink').trim();ctx.font='600 14px -apple-system, Arial';
    ctx.fillText(this.state.heatField==='betaHat' ? 'β̂ [dimensionless]' : 'D̄ [1/m²]',12,18);
    ctx.font='14px -apple-system, Arial';ctx.fillText(`snapshot ${this.state.frame?.t ?? 0} · ${this.state.scaleMode==='log' ? 'log(1 + value)' : 'linear'} color scale`,12,38);
    ctx.fillText('Dashed wall: evaluation only',12,58);
    ctx.fillText(this.state.aspectMode==='equal' ? 'Axes: equal metres' : 'Axes: independent x/y scale',12,78);
    return new Promise((resolve,reject) => out.toBlob((blob) => blob ? resolve(blob) : reject(Error("PNG rendering failed.")),"image/png"));
  }
}

// Chart coordinates and typography use CSS pixels; device pixels are export/display only.
function chartSurface(canvas) {
  const width=canvas.clientWidth,height=canvas.clientHeight;
  if (width<1 || height<1) return null;
  const ratio=window.devicePixelRatio || 1;
  canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
  const ctx=canvas.getContext("2d"),css=getComputedStyle(document.documentElement),color=(name) => css.getPropertyValue(`--color-${name}`).trim();
  ctx.scale(ratio,ratio);ctx.fillStyle=color("plot-bg");ctx.fillRect(0,0,width,height);
  return {ctx,width,height,color};
}
// Title is optional: when the card header already names the metric, the plot takes its space.
function chartAxes(surface,{title='',xLabel,yLabel,xmin,xmax,ymin,ymax,top=0,height=surface.height,compact=false,metreX=false}) {
  compact ||= height<420;
  // Margins keep tick labels, axis titles and the chart title on separate lines.
  const {ctx,width,color}=surface,padTop=compact ? (title ? 27 : 14) : (title ? 36 : 18),padBottom=compact ? 36 : 46,left=compact ? 58 : 72;
  const box={x:left,y:top+padTop,w:Math.max(1,width-left-14),h:Math.max(1,height-padTop-padBottom)};
  if (!(xmax>xmin)) xmax=xmin+1;
  if (!(ymax>ymin)) ymax=ymin+1;
  const x=(v) => box.x+(v-xmin)/(xmax-xmin)*box.w,y=(v) => box.y+box.h-(v-ymin)/(ymax-ymin)*box.h;
  const xs=metreX ? metreTicks(xmin,xmax) : Array.from({length:5},(_,i)=>xmin+(xmax-xmin)*i/4);
  drawGrid(ctx,box,xs.map(x),Array.from({length:5},(_,i)=>box.y+box.h*i/4),color('grid'));
  if (title) drawRich(ctx,title,12,top+(compact ? 17 : 24),{size:compact ? 15 : 16,weight:600,color:color("ink")});
  ctx.strokeStyle=color("line");ctx.lineWidth=1;ctx.strokeRect(box.x,box.y,box.w,box.h);
  const tickSize=compact ? 14 : 15;ctx.font=uiFont(tickSize);ctx.fillStyle=color("ink-muted");
  for (const xx of metreX ? xs : [xmin,(xmin+xmax)/2,xmax]) {
    ctx.textAlign="center";ctx.fillText(numberLabel(xx),x(xx),box.y+box.h+(compact ? 16 : 20));
  }
  for (let i=0;i<=2;i++) {
    const yy=ymin+(ymax-ymin)*i/2;
    ctx.textAlign="right";ctx.fillText(numberLabel(yy),box.x-9,y(yy)+5);
  }
  drawRich(ctx,xLabel,box.x+box.w/2,top+height-(compact ? 3 : 6),{size:tickSize,align:"center",color:color("ink-muted")});
  if (!compact) { ctx.save();ctx.translate(20,box.y+box.h/2);ctx.rotate(-Math.PI/2);drawRich(ctx,yLabel,0,0,{size:tickSize,align:"center",color:color("ink-muted")});ctx.restore(); }
  return {box,x,y};
}
function chartLine(surface,axes,points,color,dash=[],errorBars=false,dots=false,endDot=false) {
  const {ctx}=surface,{x,y,box}=axes;
  ctx.save();ctx.beginPath();ctx.rect(box.x,box.y,box.w,box.h);ctx.clip();
  ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=2;ctx.lineJoin="round";ctx.lineCap=dash.length ? "butt" : "round";ctx.setLineDash(dash);
  ctx.beginPath();let first=true;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { first=true;continue; }
    first ? ctx.moveTo(x(p.x),y(p.y)) : ctx.lineTo(x(p.x),y(p.y));first=false;
  }
  if (!dots) ctx.stroke();ctx.setLineDash([]);
  for (const p of points) if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
    if (errorBars && Number.isFinite(p.sd)) {
      const xx=x(p.x),lo=y(p.y-p.sd),hi=y(p.y+p.sd);ctx.beginPath();ctx.moveTo(xx,lo);ctx.lineTo(xx,hi);ctx.moveTo(xx-5,lo);ctx.lineTo(xx+5,lo);ctx.moveTo(xx-5,hi);ctx.lineTo(xx+5,hi);ctx.stroke();
    }
    if (dots || errorBars) { ctx.beginPath();ctx.arc(x(p.x),y(p.y),4,0,Math.PI*2);ctx.fill(); }
  }
  ctx.restore();
  // Latest value: a filled end-dot with a surface ring, drawn unclipped at the frame edge.
  const last=endDot && points.findLast(p=>Number.isFinite(p.x) && Number.isFinite(p.y));
  if (last) { ctx.save();ctx.beginPath();ctx.arc(x(last.x),y(last.y),4.5,0,Math.PI*2);ctx.lineWidth=4;ctx.strokeStyle=surface.color("plot-bg");ctx.stroke();ctx.fillStyle=color;ctx.fill();ctx.restore(); }
}
function extent(points,includeZero=true) {
  const values=points.flatMap(p => Number.isFinite(p.y) ? [p.y-(p.sd ?? 0),p.y+(p.sd ?? 0)] : []);
  let min=values.length ? values.reduce((a,b)=>Math.min(a,b),Infinity) : 0,max=values.length ? values.reduce((a,b)=>Math.max(a,b),-Infinity) : 1;
  if (includeZero) min=Math.min(0,min);
  const padding=(max-min || 1)*.12;
  return [min<0 ? min-padding : 0,max+padding];
}
export function drawMetricHistory(canvas,evaluations,selection='all',snapshots=evaluations.at(-1)?.t ?? 60) {
  const surface=chartSurface(canvas);if (!surface) return;
  const metrics=[["precision","Centre precision [%]","%"],["recall","Observed recall [%]","%"],["firstSupportPrecision","First-support precision [%]","%"],["holdRate","Held / unselected [%]","%"],["offset","Signed offset [m]","m"],["p95","P95 distance [m]","m"],["offwall","off-wall [%]","%"]].filter(([key])=>selection==='all' || key===selection);
  metrics.forEach(([key,title,unit],k) => {
    const points=evaluations.map(e => ({x:e.t,y:e[key]==null ? NaN : e[key]*(unit==="%" ? 100 : 1)})),[ymin,ymax]=unit==="%" ? [0,100] : extent(points);
    // A single selected metric is already named by the card's selector.
    const axes=chartAxes(surface,{title:metrics.length>1 ? title : '',xLabel:"snapshot",yLabel:unit,xmin:0,xmax:Math.max(1,snapshots),ymin,ymax,top:k*surface.height/metrics.length,height:surface.height/metrics.length,compact:surface.height<420});
    chartLine(surface,axes,points,surface.color("eval"),[],false,false,true);
  });
}
export function drawSweep(canvas,aggregates,reference=[],metric='medianError') {
  const surface=chartSurface(canvas);if (!surface) return;
  const colors=["#0072b2","#d55e00","#009e73","#cc79a7"],roughness=[...new Set(aggregates.map(a => a.roughness))].sort((a,b) => a-b);
  const scale=metric==='recall' ? 100 : 1, metricLabel=metric==='recall' ? 'Observed recall' : 'Median distance';
  const all=aggregates.map(a => ({x:a.sigmaD,y:a[metric].mean == null ? NaN : scale*a[metric].mean,sd:a[metric].sd == null ? null : scale*a[metric].sd})),[ymin,ymax]=metric==='recall' ? [0,100] : extent([...all,...reference.map(a=>({y:a.medianError}))]);
  const xmin=Math.min(.05,...aggregates.map(a=>a.sigmaD)),xmax=Math.max(.3,...aggregates.map(a=>a.sigmaD));
  const axes=chartAxes(surface,{title:aggregates.some(a => a[metric].failed) ? `${aggregates.filter(a => a[metric].failed).length} failed conditions · see table` : `${metricLabel} · mean ± 1 SD`,xLabel:"$σ_d$ [m]",yLabel:metric==='recall' ? "%" : "m",xmin,xmax,ymin,ymax,top:36,height:surface.height-36});
  const {ctx}=surface;let legendX=14;
  roughness.forEach((r,k) => {
    const color=colors[k%colors.length],points=aggregates.filter(a=>a.roughness===r).sort((a,b)=>a.sigmaD-b.sigmaD).map(a=>({x:a.sigmaD,y:a[metric].mean == null ? NaN : scale*a[metric].mean,sd:a[metric].sd == null ? null : scale*a[metric].sd}));
    chartLine(surface,axes,points,color,[],true);
    chartLine(surface,axes,reference.filter(a=>a.roughness===r).map(a=>({x:a.sigmaD,y:a.medianError})),color,[5,5]);
    // Legend: coloured line key, text in ink (identity never rides on text colour alone).
    ctx.save();ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.lineCap="round";ctx.beginPath();ctx.moveTo(legendX,19);ctx.lineTo(legendX+18,19);ctx.stroke();ctx.restore();
    legendX+=26+drawRich(ctx,`$σ$ = ${r}°`,legendX+26,24,{size:15,color:surface.color("ink")})+22;
  });
}
export function drawHistogram(canvas,ratios) {
  const surface=chartSurface(canvas);if (!surface) return;
  const finite=ratios.filter(Number.isFinite),xmin=finite.reduce((a,b)=>Math.min(a,b),0),xmax=finite.reduce((a,b)=>Math.max(a,b),4),bins=30,step=(xmax-xmin)/bins,counts=Array(bins).fill(0);
  for (const v of finite) counts[Math.min(bins-1,Math.floor((v-xmin)/step))]++;
  const density=counts.map((n,k) => ({x:xmin+(k+.5)*step,y:finite.length ? n/(finite.length*step) : 0}));
  const theoretical=Array.from({length:160},(_,k) => {const x=Math.max(.02,xmin+(xmax-xmin)*(k+.5)/160);return{x,y:Math.exp(-x/2)/Math.sqrt(2*Math.PI*x)};});
  const [,ymax]=extent([...density,...theoretical]);
  const axes=chartAxes(surface,{title:"Ratio density · dashed $χ^2_1$",xLabel:"$z = (ρ − ρ^*) / ς$",yLabel:"density",xmin,xmax,ymin:0,ymax});
  const {ctx}=surface;ctx.save();ctx.beginPath();ctx.rect(axes.box.x,axes.box.y,axes.box.w,axes.box.h);ctx.clip();ctx.fillStyle=surface.color("eval");
  for (const p of density) ctx.fillRect(axes.x(p.x-step*.45),axes.y(p.y),(axes.x(xmin+step)-axes.x(xmin))*.9,axes.y(0)-axes.y(p.y));
  ctx.restore();chartLine(surface,axes,theoretical,surface.color("ink"),[6,5]);
}
export function drawProfile(canvas,cells,xRange=[0,60]) {
  const surface=chartSurface(canvas);if (!surface) return;
  const fields=[["delta","$δ$ [deg]","deg",180/Math.PI],["w","$w(s)$ · dimensionless","w",1],["lambda","$Λ(s)$ · expected count / cell","count",1]];
  fields.forEach(([key,title,unit,multiplier],k) => {
    const all=cells.map(c=>({x:c.s[0],y:c[key]*multiplier})),[ymin,ymax]=extent(all),axes=chartAxes(surface,{title,xLabel:"$x$ [m] · lower solid / upper dashed",yLabel:unit,xmin:xRange[0],xmax:xRange[1],ymin,ymax,top:k*surface.height/3,height:surface.height/3,metreX:true});
    for (const wall of [0,1]) chartLine(surface,axes,cells.filter(c=>c.wall===wall).map(c=>({x:c.s[0],y:c[key]*multiplier})),surface.color("eval"),wall ? [6,4] : []);
  });
}
export function drawCounts(canvas,counts,predicted) {
  const surface=chartSurface(canvas);if (!surface) return;
  const points=counts.map((n,k)=>({x:predicted[k],y:n})).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)),maximum=Math.max(1,...points.flatMap(p=>[p.x,p.y]))*1.1;
  const axes=chartAxes(surface,{title:"Diffuse count · dashed $y = x$",xLabel:"Locally predicted count",yLabel:"Actual count",xmin:0,xmax:maximum,ymin:0,ymax:maximum});
  chartLine(surface,axes,[{x:0,y:0},{x:maximum,y:maximum}],surface.color("ink"),[5,5]);
  chartLine(surface,axes,points,surface.color("eval"),[],false,true);
}

/** Shared-axis comparison; one solid and one dashed curve distinguish methods.
 * Missing precision stays a gap. No smoothing, interpolation of missing data or CI.
 */
export function drawComparisonHistory(canvas,evaluations,selection='recall',snapshots=120) {
  const surface=chartSurface(canvas);if(!surface)return;
  const percent=selection!=='p95',series=['guarded','baseline'].map(method=>evaluations.map(e=>{
    const value=e.methods?.[method]?.[selection];return {x:e.t,y:value==null ? NaN : value*(percent?100:1)};
  }));
  const [ymin,ymax]=percent?[0,100]:extent(series.flat());
  const axes=chartAxes(surface,{xLabel:'Snapshot',yLabel:percent?'%':'m',xmin:0,xmax:Math.max(1,snapshots),ymin,ymax,compact:true});
  chartLine(surface,axes,series[0],surface.color('accent'),[],false,false,true);
  chartLine(surface,axes,series[1],surface.color('baseline'),[6,4],false,false,true);
}

/** Link user navigation only; each view retains its own data and heatmap. */
export function linkMapCameras(left,right,enabled=()=>true) {
  for (const [source,target] of [[left,right],[right,left]]) source.onCameraChange=()=>{
    if (!enabled()) return;
    target.camera=source.camera ? {...source.camera} : null;
    target.auto=source.auto;target.fullDomain=source.fullDomain;target.draw();
  };
}
