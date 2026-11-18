import {createContext,applySelection} from './candidates.mjs';
import {scoreCandidates} from './policy.mjs';

const METHODS=['ridge','gbdt','extraTrees'];
export const TRAINED_FLEETS=Object.freeze([3,5,7,10]);

/**
 * Input: consecutive measured wires from makeWire, with stable configuration order.
 * Output: all pair poses, but paths from at most ten selected pairs per snapshot.
 * At t=1,11,... maximize predicted block-relative F1 over the frozen candidate menu;
 * hold the subset for ten snapshots. Unselected poses still advance track clocks.
 * Preprocessing is O(P + E) each step and O(P log P + PK) each selection, with
 * P vehicle pairs, E echoes and K <= 10; the ten-frame feature history uses O(P).
 * Models were trained on 3/5/7/10 vehicles. Other sizes are not accuracy-validated.
 */
export function createPairSelector(method,fleet) {
  if (!METHODS.includes(method)) throw Error('Unknown pair policy '+method);
  if (!Number.isSafeInteger(fleet)||fleet<1) throw Error('Fleet size must be a positive integer');
  const context=createContext(fleet);
  let selected,expected=1;
  function select(wire) {
    if (wire.t!==expected) throw Error('Snapshots must arrive consecutively');
    // The trained candidate menu does not define fleets 1/2/4; all have at most six pairs.
    if (fleet<3||fleet===4) {
      select.selectedCount=wire.configs.length;
      select.selectedPairs=wire.configs.map((_,i)=>i);
      select.lastChoice='all';
      expected++;
      return wire;
    }
    context.observe(wire);
    if (!selected) selected=context.fixedPairs();
    if ((wire.t-1)%10===0) {
      const choices=context.candidates(selected);
      const scores=scoreCandidates(choices.map(c=>c.features),method);
      if (!Array.isArray(scores)||scores.length!==choices.length||!scores.every(Number.isFinite)) throw Error('Invalid model candidate scores');
      let index=0;
      for (let j=1;j<scores.length;j++) if (scores[j]>scores[index]) index=j;
      selected=choices[index].pairs;select.lastChoice=choices[index].name;
    }
    select.selectedCount=selected.length;select.selectedPairs=selected;
    const filtered=applySelection(wire,selected);
    expected++;
    return filtered;
  }
  return select;
}
