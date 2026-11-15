// Keep the full name for screen readers and use the short label only when the rendered name wraps.
const full='EchoSpline + GBDT';
export function fitMethodLabel(node){
  const text=node.dataset.fullMethodLabel;
  if(!text || !node.getClientRects().length)return;
  node.textContent=text;
  const range=node.ownerDocument.createRange();range.selectNodeContents(node);
  const lines=range.getClientRects();
  if(lines.length>1 || lines[0] && node.clientWidth>0 && lines[0].width>node.clientWidth+.5)
    node.textContent=text.replace(full,'+GBDT');
}
export function setMethodLabel(node,text){
  if(node.dataset.fullMethodLabel===text)return;
  if(text.includes(full)){
    node.dataset.fullMethodLabel=text;node.textContent=text;
    node.setAttribute('aria-label',text);node.title=text;
    fitMethodLabel(node);
  }else{
    if(node.dataset.fullMethodLabel){
      delete node.dataset.fullMethodLabel;node.removeAttribute('aria-label');node.removeAttribute('title');
    }
    if(node.textContent!==text)node.textContent=text;
  }
}
