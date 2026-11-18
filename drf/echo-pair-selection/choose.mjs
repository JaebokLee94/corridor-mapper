export function chooseVehicles(wire) {
  const lookup = new Map();
  for (const p of wire.configs) {
    lookup.set(p.i, p.pHat_i);
    lookup.set(p.j, p.pHat_j);
  }
  const ids = [...lookup.keys()].sort((a, b) => a - b);
  function best(candidates, score) {
    return candidates.reduce((a, b) => score(b) > score(a) ? b : a);
  }
  const a = best(ids, i => -lookup.get(i)[0]);
  const [x,y] = lookup.get(a);
  const b = best(ids.filter(i => i !== a), i => Math.hypot(lookup.get(i)[0] - x, lookup.get(i)[1] - y));
  const [bx,by] = lookup.get(b);
  const c = best(ids.filter(i => i !== a && i !== b), i => Math.abs((bx-x)*(lookup.get(i)[1]-y) - (by-y)*(lookup.get(i)[0]-x)));
  const chosen=[a,b,c];
  function distance(i,j){
    return Math.hypot(lookup.get(i)[0] - lookup.get(j)[0], lookup.get(i)[1] - lookup.get(j)[1]);
  }
  while (chosen.length < 5) {
    const remaining = ids.filter(i => !chosen.includes(i));
    chosen.push(best(remaining, i => Math.min(...chosen.map(j => distance(i,j)))));
  }
  return chosen;
}

