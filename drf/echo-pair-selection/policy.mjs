import models from './models.mjs';

function dot(a,b) {
  let value=0;
  for (let j=0;j<a.length;j++) value+=a[j]*b[j];
  return value;
}

function treeValue(tree,features) {
  let index=0,node=tree[index];
  while (node[0]>=0) {
    index=features[node[0]]<=node[1]?node[2]:node[3];
    node=tree[index];
  }
  return node[1];
}

/**
 * Input: C x 26 finite current/past-only features, C <= 10 candidate pair subsets.
 * Output: C predicted block-relative observed-wall F1 scores; choose their argmax.
 * For F features and T depth-D trees, scoring costs O(CF) or O(CTD).
 * Temporary memory is O(F), excluding the once-loaded model weights.
 * Ground truth and estimator output are never inputs.
 */
export function scoreCandidates(features,modelName) {
  const model=models.models[modelName];
  if (!model) throw Error('Unknown candidate scorer '+modelName);
  return features.map(row=>{
    if (row.length!==models.mean.length || !row.every(Number.isFinite)) throw Error('Invalid candidate features');
    const x=row.map((v,j)=>(v-models.mean[j])/models.scale[j]);
    if (model.kind==='linear') return model.intercept+dot(x,model.weights);
    if (model.kind!=='trees') throw Error('Invalid candidate model type');
    // sklearn trees compare float32 feature values against float64 thresholds.
    const rounded=x.map(Math.fround);
    return model.intercept+model.factor*model.trees.reduce((sum,t)=>sum+treeValue(t,rounded),0);
  });
}
