// Rectangular shortest augmenting paths, using the research implementation’s tie order.
export function minimumAssignment(rows,cols,cost){
  if(!rows||!cols)return [];
  if(rows>cols)return minimumAssignment(cols,rows,(j,i)=>cost(i,j)).map(([j,i])=>[i,j]).sort((a,b)=>a[0]-b[0]);
  const u=new Float64Array(rows),v=new Float64Array(cols);
  const byRow=new Int32Array(rows).fill(-1),byCol=new Int32Array(cols).fill(-1);
  for(let start=0;start<rows;start++){
    const remaining=Array.from({length:cols},(_,i)=>cols-1-i),seenRow=new Set(),seenCol=new Set();
    const dist=new Float64Array(cols).fill(Infinity),path=new Int32Array(cols);
    let row=start,best=0,col;
    for(;;){
      seenRow.add(row);let low=Infinity,at=0;
      remaining.forEach((j,index)=>{
        const r=best+cost(row,j)-u[row]-v[j];
        if(r<dist[j]){dist[j]=r;path[j]=row;}
        if(dist[j]<low||dist[j]===low&&byCol[j]===-1){low=dist[j];at=index;}
      });
      best=low;col=remaining[at];remaining[at]=remaining.at(-1);remaining.pop();seenCol.add(col);
      if(byCol[col]===-1)break;row=byCol[col];
    }
    u[start]+=best;
    for(const r of seenRow)if(r!==start)u[r]+=best-dist[byRow[r]];
    for(const j of seenCol)v[j]-=best-dist[j];
    do{row=path[col];byCol[col]=row;const prev=byRow[row];byRow[row]=col;col=prev;}while(row!==start);
  }
  return Array.from(byRow,(col,row)=>[row,col]);
}
