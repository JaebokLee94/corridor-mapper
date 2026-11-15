export const rightMethods={
  gbdt:{name:'EchoSpline + GBDT',curves:true,description:'Frozen height-residual trees on the 2 m EchoSpline fit with 8 m support.'},
  gat:{name:'GAT + GPR',curves:true,description:'Jung et al. GAT on four measured snapshots, followed by DBSCAN and Gaussian process regression.'},
  wmp:{name:'WM-P',description:'Wall Mapping with Pair Tracking'},
  arc:{name:'EchoArc-CNN',curves:true,description:'Upper-arc ellipse votes and a frozen CNN. Peak probability threshold 0.70.'}
};
